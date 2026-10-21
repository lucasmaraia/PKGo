// Installs PKGs one at a time through the GoldHEN install payload.
import {ACTIVE_JOB_STATES, MAX_ATTEMPTS, type Job} from '@shared/types';
import {AppError, hex, toErrorInfo} from '../errors';
import type {LibraryEntry} from '../library/LibraryService';
import type {PackageRequest} from '../payload/PayloadClient';
import type {ServedRanges} from '../server/ServedRanges';

/** What the queue needs from the PKG file server. */
export interface FileAccess {
  served: ServedRanges;
  /** Stops serving a file (cuts downloads in progress). */
  block(id: string): void;
  unblock(id: string): void;
}

export interface InstallContext {
  library: (id: string) => LibraryEntry | undefined;
  title: (entry: LibraryEntry) => string;
  payload: {available: boolean; install(ps4Ip: string, pcIp: string, pkg: PackageRequest): Promise<void>};
  files: FileAccess;
  /** Console IP, this PC's LAN IP and the PKG server port, read when a job starts. */
  network: () => {ps4Ip: string; pcIp: string | null; port: number};
  /**
   * Removes a stopped download from the PS4 download list, by task ID or, when
   * that is unknown (null), by content ID. Resolves false when it could not.
   */
  removeTask: (task: string | null, entry: LibraryEntry) => Promise<boolean>;
  onChange: () => void;
  /** A job is about to be sent to the console. */
  onStart?: (job: Job) => void;
  /** Called once the console has downloaded the whole package (it still has to install it). */
  onDownloaded: (entry: LibraryEntry) => void;
  log?: (message: string) => void;
}

export interface QueueTiming {
  /** The console has to start downloading within this time, and may not stall for longer. */
  startTimeout: number;
  stallTimeout: number;
  /** Wait before sending a failed download again. */
  retryDelay: number;
  /** Wait after a stop before removing the download, so the PS4 has registered (and logged) it. */
  cleanupDelay: number;
}

const TIMING: QueueTiming = {startTimeout: 60_000, stallTimeout: 180_000, retryDelay: 10_000, cleanupDelay: 2000};

/** Failures that a new try may fix (network drops, a busy or briefly unreachable console). */
const RETRYABLE = new Set(['downloadStalled', 'downloadNotStarted', 'ps4DownloadFailed', 'payloadNoAnswer']);

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const isRunning = (job: Job) => job.state === 'starting' || job.state === 'installing';

/** BGFT package type: "PS4" + param.sfo category (GD game, GP update, AC DLC…). */
export function bgftType(entry: LibraryEntry): string {
  const fallback = {game: 'gd', patch: 'gp', dlc: 'ac', app: 'gd', other: 'gd'}[entry.info.kind || 'other'];
  return `PS4${(entry.info.category || fallback).toUpperCase()}`;
}

export class InstallQueue {
  readonly jobs: Job[] = [];
  private nextId = 1;
  private pumping = false;
  /** Removal of stopped downloads; the next job waits for it (both use the BinLoader). */
  private cleaning: Promise<unknown> = Promise.resolve();
  private readonly timing: QueueTiming;

  constructor(
    private readonly ctx: InstallContext,
    timing: Partial<QueueTiming> = {},
  ) {
    this.timing = {...TIMING, ...timing};
  }

  get busy(): boolean {
    return this.jobs.some(j => ACTIVE_JOB_STATES.includes(j.state));
  }

  enqueue(id: string): Job {
    const entry = this.ctx.library(id);
    if (!entry) throw new AppError('pkgNotFound');
    if (entry.error) throw new AppError('pkgUnreadable');
    if (this.jobs.some(j => j.pkgId === id && ACTIVE_JOB_STATES.includes(j.state))) throw new AppError('alreadyQueued');
    const job: Job = {
      id: this.nextId++,
      pkgId: id,
      title: this.ctx.title(entry),
      state: 'queued',
      total: entry.size,
      transferred: 0,
      speed: 0,
      eta: null,
      error: null,
      createdAt: Date.now(),
      attempt: 1,
    };
    this.jobs.push(job);
    this.ctx.onChange();
    void this.pump();
    return job;
  }

  /**
   * Removes a waiting job, or stops one being sent: the file stops being
   * served and the download is removed from the PS4 list.
   */
  cancel(jobId: number): void {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job || !ACTIVE_JOB_STATES.includes(job.state)) throw new AppError('jobNotActive');
    this.ctx.log?.(`job ${job.id} cancelled (${job.state})`);
    if (job.state === 'queued') this.jobs.splice(this.jobs.indexOf(job), 1);
    else {
      // While starting, the PS4 has no download yet: run() removes it once sent.
      if (job.state === 'installing') this.cleanup(job);
      Object.assign(job, {state: 'cancelled', speed: 0, eta: null, finishedAt: Date.now()});
      this.ctx.files.block(job.pkgId);
    }
    this.ctx.onChange();
  }

  clearFinished(): void {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      if (!ACTIVE_JOB_STATES.includes(this.jobs[i]!.state)) this.jobs.splice(i, 1);
    }
    this.ctx.onChange();
  }

  // ---------- what the PS4 reports (see KlogMonitor) ----------

  /** A download task created by our payload: it belongs to the job being sent. */
  attachTask(task: string): void {
    const job = this.jobs.find(j => isRunning(j) && !j.taskId);
    if (job) {
      job.taskId = task;
      this.ctx.log?.(`job ${job.id} is PS4 task ${task}`);
    }
  }

  /** The PS4 ended a download task; a non-zero error means it failed there. */
  taskEnded(task: string, error: number): void {
    const job = this.jobs.find(j => j.taskId === task && isRunning(j));
    if (job && error) this.fail(job, new AppError('ps4DownloadFailed', {code: hex(error)}));
  }

  /** The task was removed on the PS4 (e.g. deleted from its notifications) before finishing. */
  taskDeleted(task: string): void {
    const job = this.jobs.find(j => j.taskId === task && isRunning(j));
    if (job) this.fail(job, new AppError('ps4Cancelled'));
  }

  /** The PS4 finished installing a downloaded package. */
  installEnded(task: string, result: number): void {
    const job = this.jobs.find(j => j.taskId === task);
    if (job && result) this.fail(job, new AppError('installFailed', {code: hex(result)}));
  }

  // ---------- running ----------

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let job: Job | undefined;
      while ((job = this.jobs.find(j => j.state === 'queued' && !(j.retryAt && j.retryAt > Date.now())))) {
        await this.cleaning;
        // Cancelled while the previous download was being removed.
        if (job.state !== 'queued') continue;
        try {
          await this.run(job);
        } catch (e) {
          if (isRunning(job)) this.fail(job, e);
        }
        this.ctx.onChange();
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Stops a job that failed: sends it again later when a new try may help. */
  private fail(job: Job, error: unknown): void {
    const info = toErrorInfo(error);
    this.ctx.log?.(`job ${job.id} attempt ${job.attempt} failed: ${info.code} ${JSON.stringify(info.params ?? {})}`);
    this.ctx.files.block(job.pkgId);
    // Only a download the PS4 registered can be removed. Deleted on the PS4:
    // nothing to remove there.
    if ((job.state === 'installing' || job.state === 'done') && info.code !== 'ps4Cancelled') this.cleanup(job);
    if (RETRYABLE.has(info.code) && job.attempt < MAX_ATTEMPTS) {
      Object.assign(job, {
        state: 'queued',
        attempt: job.attempt + 1,
        retryAt: Date.now() + this.timing.retryDelay,
        error: info,
        transferred: 0,
        speed: 0,
        eta: null,
        taskId: undefined,
      });
      setTimeout(() => void this.pump(), this.timing.retryDelay);
    } else {
      Object.assign(job, {
        state: 'error',
        error: info,
        speed: 0,
        eta: null,
        retryAt: undefined,
        finishedAt: Date.now(),
      });
    }
    this.ctx.onChange();
  }

  /** Removes the job's stopped download from the PS4 list (in the background). */
  private cleanup(job: Job): void {
    const entry = this.ctx.library(job.pkgId);
    if (!entry) return;
    // Taken now: a new try of the same job gets another task.
    const task = job.taskId ?? null;
    const attempt = job.attempt;
    job.cleanup = 'running';
    const done = (async () => {
      await sleep(this.timing.cleanupDelay);
      const removed = await this.ctx.removeTask(task, entry).catch(() => false);
      this.ctx.log?.(`job ${job.id}: PS4 download ${removed ? 'removed' : 'could not be removed'}`);
      if (job.attempt === attempt) {
        job.cleanup = removed ? 'done' : 'failed';
        this.ctx.onChange();
      }
    })();
    this.cleaning = Promise.all([this.cleaning, done]);
  }

  private async run(job: Job): Promise<void> {
    const entry = this.ctx.library(job.pkgId);
    if (!entry) throw new AppError('pkgRemoved');
    const {ps4Ip, pcIp, port} = this.ctx.network();
    if (!ps4Ip) throw new AppError('ps4NotConfigured');
    if (!pcIp) throw new AppError('noLan');
    if (!this.ctx.payload.available) throw new AppError('payloadMissing');
    Object.assign(job, {state: 'starting', startedAt: Date.now(), retryAt: undefined, cleanup: undefined});
    this.ctx.onStart?.(job);
    this.ctx.onChange();

    const {served} = this.ctx.files;
    served.reset(entry.id);
    this.ctx.files.unblock(entry.id);
    this.ctx.log?.(
      `job ${job.id} attempt ${job.attempt}: sending ${entry.name} (${bgftType(entry)}, ${entry.size} bytes)`,
    );
    await this.ctx.payload.install(ps4Ip, pcIp, {
      url: `http://${pcIp}:${port}/pkg/${entry.id}.pkg`,
      name: job.title,
      contentId: entry.info.contentId || '',
      type: bgftType(entry),
      size: entry.size,
      icon: entry.info.icon,
    });
    // Cancelled while the payload was being sent: the PS4 registers it anyway.
    if (job.state !== 'starting') return this.cleanup(job);
    job.state = 'installing';
    this.ctx.onChange();

    let last = {time: Date.now(), bytes: 0};
    let lastChange = Date.now();
    for (;;) {
      await sleep(1000);
      if (job.state !== 'installing') return;
      const done = Math.min(served.bytes(entry.id), entry.size);
      const now = Date.now();
      if (done > last.bytes) lastChange = now;
      else if (now - lastChange > (done ? this.timing.stallTimeout : this.timing.startTimeout)) {
        throw new AppError(done ? 'downloadStalled' : 'downloadNotStarted');
      }
      const instant = (done - last.bytes) / ((now - last.time) / 1000);
      job.speed = job.speed ? job.speed * 0.7 + instant * 0.3 : instant;
      last = {time: now, bytes: done};
      job.transferred = done;
      job.eta = job.speed > 0 ? (entry.size - done) / job.speed : null;
      this.ctx.onChange();
      if (done >= entry.size) break;
    }
    Object.assign(job, {state: 'done', transferred: job.total, speed: 0, eta: 0, finishedAt: Date.now()});
    this.ctx.log?.(`job ${job.id}: downloaded by the PS4`);
    this.ctx.onDownloaded(entry);
  }
}
