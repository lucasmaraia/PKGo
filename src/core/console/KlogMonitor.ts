// Follows the GoldHEN kernel log (klog, port 3232) to learn what the PS4 does
// with our downloads as it happens: failures, cancels, installs, deletions.
// It is best effort: without the log, the app falls back to timeouts and to
// re-reading the console list.
import {EventEmitter} from 'node:events';
import net from 'node:net';

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

/** Keeps a connection to the klog of `host()` while it is set, reconnecting when it drops. */
export class KlogMonitor extends EventEmitter<{event: [KlogEvent]}> {
  private socket: net.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private host = '';
  private running = false;

  constructor(
    private readonly target: () => string,
    private readonly port = KLOG_PORT,
    private readonly retryMs = 5000,
  ) {
    super();
  }

  start(): void {
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.destroy();
    this.socket = null;
  }

  /** Reconnects when the console address changes. */
  restart(): void {
    this.socket?.destroy();
  }

  private retry(): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.retryMs);
  }

  private connect(): void {
    this.host = this.target();
    if (!this.running) return;
    if (!this.host) return this.retry();
    const socket = net.connect(this.port, this.host);
    this.socket = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
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
      if (this.socket === socket) this.socket = null;
      this.retry();
    });
  }
}
