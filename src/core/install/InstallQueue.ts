// Installs PKGs one at a time through the GoldHEN install payload.
import {ACTIVE_JOB_STATES, type Job} from '@shared/types';
import {AppError, toErrorInfo} from '../errors';
import type {LibraryEntry} from '../library/LibraryService';
import type {InstallPayload} from '../payload/PayloadClient';
import type {ServedRanges} from '../server/ServedRanges';

export interface InstallContext {
  library: (id: string) => LibraryEntry | undefined;
  title: (entry: LibraryEntry) => string;
  payload: InstallPayload;
  served: ServedRanges;
  /** Console IP, this PC's LAN IP and the PKG server port, read when a job starts. */
  network: () => {ps4Ip: string; pcIp: string | null; port: number};
  onChange: () => void;
  /** Called after a package finished downloading. */
  onInstalled: () => void;
}

/** The console has to start downloading within this time, and may not stall for longer. */
const START_TIMEOUT = 60_000;
const STALL_TIMEOUT = 180_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

  cancel(jobId: number): void {
    const job = this.jobs.find(j => j.id === jobId);
    if (!job || job.state !== 'queued') throw new AppError('cancelOnlyQueued');
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.ctx.onChange();
  }

  clearFinished(): void {
    for (let i = this.jobs.length - 1; i >= 0; i--) {
      if (!ACTIVE_JOB_STATES.includes(this.jobs[i]!.state)) this.jobs.splice(i, 1);
    }
    this.ctx.onChange();
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
          this.fail(job, e);
        }
        this.ctx.onChange();
      }
    } finally {
      this.pumping = false;
    }
  }

  private fail(job: Job, error: unknown): void {
    Object.assign(job, {state: 'error', error: toErrorInfo(error), finishedAt: Date.now()});
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

    this.ctx.served.reset(entry.id);
    await this.ctx.payload.install(ps4Ip, pcIp, {
      url: `http://${pcIp}:${port}/pkg/${entry.id}.pkg`,
      name: job.title,
      contentId: entry.info.contentId || '',
      type: bgftType(entry),
      size: entry.size,
      icon: entry.info.icon,
    });
    job.state = 'installing';
    this.ctx.onChange();

    let last = {time: Date.now(), bytes: 0};
    let lastChange = Date.now();
    for (;;) {
      await sleep(1000);
      const done = Math.min(this.ctx.served.bytes(entry.id), entry.size);
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
    // Give the console a moment to register the package before listing it.
    setTimeout(this.ctx.onInstalled, 8000);
  }
}
