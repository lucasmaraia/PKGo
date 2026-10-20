// Installs PKGs one at a time through the GoldHEN install payload.
import {ACTIVE_JOB_STATES, type Job} from '@shared/types';
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
  onChange: () => void;
  /** Called once the console has downloaded the whole package (it still has to install it). */
  onDownloaded: (entry: LibraryEntry) => void;
}

/** The console has to start downloading within this time, and may not stall for longer. */
const START_TIMEOUT = 60_000;
const STALL_TIMEOUT = 180_000;

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

  constructor(private readonly ctx: InstallContext) {}

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
    };
    this.jobs.push(job);
    this.ctx.onChange();
    void this.pump();
    return job;
  }

  /**
   * Removes a waiting job, or stops one being sent: the file stops being
   * served, so the PS4 sees its download fail (it keeps a failed entry in its
   * notifications, which the payload cannot remove).
   */
  cancel(jobId: number): void {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job || !ACTIVE_JOB_STATES.includes(job.state)) throw new AppError('jobNotActive');
    if (job.state === 'queued') this.jobs.splice(this.jobs.indexOf(job), 1);
    else {
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
    if (job) job.taskId = task;
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

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let job: Job | undefined;
      while ((job = this.jobs.find(j => j.state === 'queued'))) {
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

  private fail(job: Job, error: unknown): void {
    Object.assign(job, {state: 'error', error: toErrorInfo(error), speed: 0, eta: null, finishedAt: Date.now()});
    this.ctx.files.block(job.pkgId);
    this.ctx.onChange();
  }

  private async run(job: Job): Promise<void> {
    const entry = this.ctx.library(job.pkgId);
    if (!entry) throw new AppError('pkgRemoved');
    const {ps4Ip, pcIp, port} = this.ctx.network();
    if (!ps4Ip) throw new AppError('ps4NotConfigured');
    if (!pcIp) throw new AppError('noLan');
    if (!this.ctx.payload.available) throw new AppError('payloadMissing');
    Object.assign(job, {state: 'starting', startedAt: Date.now()});
    this.ctx.onChange();

    const {served} = this.ctx.files;
    served.reset(entry.id);
    this.ctx.files.unblock(entry.id);
    await this.ctx.payload.install(ps4Ip, pcIp, {
      url: `http://${pcIp}:${port}/pkg/${entry.id}.pkg`,
      name: job.title,
      contentId: entry.info.contentId || '',
      type: bgftType(entry),
      size: entry.size,
      icon: entry.info.icon,
    });
    // Cancelled (or failed on the PS4) while the payload was being sent.
    if (job.state !== 'starting') return;
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
      else if (now - lastChange > (done ? STALL_TIMEOUT : START_TIMEOUT)) {
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
    this.ctx.onDownloaded(entry);
  }
}
