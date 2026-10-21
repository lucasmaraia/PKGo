// Follows the GoldHEN kernel log (klog, port 3232) to learn what the PS4 does
// with our downloads as it happens: failures, cancels, installs, deletions.
// It is best effort: without the log, the app falls back to timeouts and to
// re-reading the console list.
//
// GoldHEN serves one reader at a time: a new connection closes the previous
// one. When something else keeps taking the log, the monitor backs off
// instead of fighting over it, and reconnects when a download needs it.
import {EventEmitter} from 'node:events';
import net from 'node:net';
import type {KlogStatus} from '@shared/types';

export const KLOG_PORT = 3232;

/** Task option the install payload sets (BGFT_TASK_OPTION_DISABLE_CDN_QUERY_PARAM): marks our tasks. */
const PAYLOAD_TASK_OPTION = '00010000';

export type KlogEvent =
  | {type: 'ourTask'; task: string}
  | {type: 'taskEnded'; task: string; state: number; error: number}
  | {type: 'taskDeleted'; task: string}
  | {type: 'installEnded'; task: string; result: number}
  | {type: 'gameDeleted'; titleId: string};

/** Reads one klog line; null when it is not about downloads or installs. */
export function parseKlogLine(line: string): KlogEvent | null {
  let m: RegExpExecArray | null;
  if ((m = /Task ([0-9a-f]{8}) : option ([0-9a-f]{8})/.exec(line))) {
    return m[2] === PAYLOAD_TASK_OPTION ? {type: 'ourTask', task: m[1]!} : null;
  }
  if ((m = /Task ([0-9a-f]{8}) : .*: ended \(state=(\d+),runstate=\d+,error=0x([0-9a-fA-F]+)\)/.exec(line))) {
    return {type: 'taskEnded', task: m[1]!, state: Number(m[2]), error: parseInt(m[3]!, 16) | 0};
  }
  if ((m = /Task ([0-9a-f]{8}) : deleted/.exec(line))) return {type: 'taskDeleted', task: m[1]!};
  if ((m = /end sceAppInstaller::AppInstallApp\(.*\/bgft\/task\/([0-9a-f]{8})\)=0x([0-9a-fA-F]+)/.exec(line))) {
    return {type: 'installEnded', task: m[1]!, result: parseInt(m[2]!, 16) | 0};
  }
  if ((m = /GameWillDelete\(([A-Z]{4}\d{5})\)/.exec(line))) return {type: 'gameDeleted', titleId: m[1]!};
  return null;
}

export interface KlogTiming {
  /** Wait before reconnecting after the connection drops or fails. */
  retryMs: number;
  /** Wait before reconnecting while another program reads the log. */
  busyRetryMs: number;
  /** Closed by the PS4 this many times within `kickWindowMs`: another reader. */
  kicks: number;
  kickWindowMs: number;
}

const TIMING: KlogTiming = {retryMs: 5000, busyRetryMs: 120_000, kicks: 2, kickWindowMs: 60_000};

/** Keeps a connection to the klog of `host()` while it is set, reconnecting when it drops. */
export class KlogMonitor extends EventEmitter<{event: [KlogEvent]; status: [KlogStatus]}> {
  private socket: net.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private kickTimes: number[] = [];
  private _status: KlogStatus = 'off';
  private readonly timing: KlogTiming;

  constructor(
    private readonly target: () => string,
    private readonly port = KLOG_PORT,
    timing: Partial<KlogTiming> = {},
  ) {
    super();
    this.timing = {...TIMING, ...timing};
  }

  get status(): KlogStatus {
    return this._status;
  }

  private setStatus(status: KlogStatus): void {
    if (status === this._status) return;
    this._status = status;
    this.emit('status', status);
  }

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.drop();
    this.setStatus('off');
  }

  /** Reconnects now: the console address changed. */
  restart(): void {
    this.kickTimes = [];
    this.drop();
    if (this.running) this.connect();
  }

  /** A download starts and needs the log: take it back if another program had it. */
  wake(): void {
    if (this.running && !this.socket) {
      this.kickTimes = [];
      this.connect();
    }
  }

  private drop(): void {
    const socket = this.socket;
    this.socket = null;
    socket?.destroy();
  }

  private retry(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private connect(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.running) return;
    const host = this.target();
    if (!host) {
      this.setStatus('off');
      return this.retry(this.timing.retryMs);
    }
    if (this._status !== 'busy') this.setStatus('connecting');
    const socket = net.connect(this.port, host);
    this.socket = socket;
    socket.setEncoding('utf8');
    let connected = false;
    let ended = false;
    let buffer = '';
    socket.on('connect', () => {
      connected = true;
      // Busy until the log flows again: being kicked right away means it still is.
      if (this._status !== 'busy') this.setStatus('live');
    });
    socket.on('end', () => (ended = true));
    socket.on('data', (chunk: string) => {
      if (this._status === 'busy') this.setStatus('live');
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const event = parseKlogLine(line);
        if (event) this.emit('event', event);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      // Closed by us (stop, restart): nothing to do.
      if (this.socket !== socket) return;
      this.socket = null;
      if (!connected) {
        this.setStatus('unavailable');
        return this.retry(this.timing.retryMs);
      }
      if (ended) {
        // The PS4 closed it: it does that when another reader connects.
        const now = Date.now();
        this.kickTimes = [...this.kickTimes.filter(t => now - t < this.timing.kickWindowMs), now];
        if (this.kickTimes.length >= this.timing.kicks) {
          this.setStatus('busy');
          return this.retry(this.timing.busyRetryMs);
        }
      }
      this.setStatus('connecting');
      this.retry(this.timing.retryMs);
    });
  }
}
