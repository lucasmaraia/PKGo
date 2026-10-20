// Minimal passive-mode FTP client for the GoldHEN FTP server (anonymous, binary).
import net from 'node:net';

interface Reply {
  code: number;
  text: string;
}

interface Waiter {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
}

export interface FtpEntry {
  name: string;
  size: number;
  dir: boolean;
}

export class FtpError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

export class FtpClient {
  private socket: net.Socket | null = null;
  private buffer = '';
  private waiters: Waiter[] = [];
  private replies: Reply[] = [];
  /** Set when a transfer ended without its final reply: reconnect before reuse. */
  dirty = false;

  constructor(
    readonly host: string,
    readonly port = 2121,
    readonly timeout = 8000,
  ) {}

  async connect(): Promise<this> {
    const socket = net.connect(this.port, this.host);
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setTimeout(this.timeout, () => socket.destroy(new Error('FTP timeout')));
    socket.on('data', (chunk: string) => this.onData(chunk));
    const closed = (err?: Error) => {
      for (const w of this.waiters.splice(0)) w.reject(err || new Error('FTP connection closed'));
    };
    socket.on('error', closed);
    socket.on('close', () => closed());
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    await this.expect(this.reply(), 2);
    const user = await this.cmd('USER anonymous');
    if (user.code === 331) await this.expect(this.cmd('PASS anonymous'), 2);
    await this.expect(this.cmd('TYPE I'), 2);
    return this;
  }

  close(): void {
    if (!this.socket) return;
    this.socket.end('QUIT\r\n');
    this.socket.destroy();
    this.socket = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // A reply ends with "NNN text"; multi-line replies start with "NNN-".
    let match: RegExpExecArray | null;
    while ((match = /^(\d{3}) [^\r\n]*\r?\n/m.exec(this.buffer))) {
      const end = match.index + match[0].length;
      const text = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const reply = {code: Number(match[1]), text: text.trim()};
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(reply);
      else this.replies.push(reply);
    }
  }

  private reply(): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => this.waiters.push({resolve, reject}));
  }

  private cmd(line: string): Promise<Reply> {
    this.socket?.write(line + '\r\n');
    return this.reply();
  }

  private async expect(promise: Promise<Reply>, klass: number): Promise<Reply> {
    const reply = await promise;
    if (Math.floor(reply.code / 100) !== klass) throw new FtpError(`FTP: ${reply.text}`, reply.code);
    return reply;
  }

  private async openData(): Promise<net.Socket> {
    const reply = await this.expect(this.cmd('PASV'), 2);
    const nums = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(reply.text);
    if (!nums) throw new Error('FTP: invalid PASV reply');
    // GoldHEN may report an internal address; the control host is the reachable one.
    const data = net.connect(Number(nums[5]) * 256 + Number(nums[6]), this.host);
    data.setTimeout(this.timeout, () => data.destroy(new Error('FTP timeout')));
    await new Promise<void>((resolve, reject) => {
      data.once('connect', resolve);
      data.once('error', reject);
    });
    return data;
  }

  /** Reads a whole transfer, or only `length` bytes from `offset` (aborting early). */
  private async transfer(command: string, {offset = 0, length = Infinity} = {}): Promise<Buffer> {
    const data = await this.openData();
    if (offset) await this.expect(this.cmd(`REST ${offset}`), 3);
    const chunks: Buffer[] = [];
    let total = 0;
    const done = new Promise<void>((resolve, reject) => {
      data.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= length) {
          data.destroy();
          resolve();
        }
      });
      data.on('end', resolve);
      data.on('close', resolve);
      data.on('error', reject);
    });
    const start = await this.cmd(command);
    const klass = Math.floor(start.code / 100);
    if (klass !== 1 && klass !== 2) {
      data.destroy();
      throw new FtpError(`FTP: ${start.text}`, start.code);
    }
    await done;
    if (klass === 1) {
      // Completion (226) or abort (426/451) reply; some servers send nothing after an early close.
      // Without it the reply stream may be out of step: callers must reconnect.
      const final = await Promise.race([this.reply(), new Promise<null>(r => setTimeout(r, 1500, null))]);
      if (!final) this.dirty = true;
    }
    const buf = Buffer.concat(chunks);
    return length === Infinity ? buf : buf.subarray(0, length);
  }

  async list(dir: string): Promise<string[]> {
    const buf = await this.transfer(`NLST ${dir}`);
    return buf
      .toString('utf8')
      .split(/\r?\n/)
      .map(s => s.trim().split('/').pop() || '')
      .filter(n => n && n !== '.' && n !== '..');
  }

  /** Files and folders of `dir` from a LIST. GoldHEN's SIZE wraps above 4 GB; LIST does not. */
  async entries(dir: string): Promise<FtpEntry[]> {
    const buf = await this.transfer(`LIST ${dir}`);
    const out: FtpEntry[] = [];
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const m = /^([-d])\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line.trim());
      if (m && m[3] !== '.' && m[3] !== '..') out.push({name: m[3]!, size: Number(m[2]), dir: m[1] === 'd'});
    }
    return out;
  }

  /** File sizes of `dir`, by name. */
  async sizes(dir: string): Promise<Map<string, number>> {
    return new Map((await this.entries(dir)).filter(e => !e.dir).map(e => [e.name, e.size]));
  }

  read(file: string, offset: number, length: number): Promise<Buffer> {
    return this.transfer(`RETR ${file}`, {offset, length});
  }
}

/**
 * Whether an FTP server greets on host:port. Reads the greeting and leaves
 * politely, so it is safe to repeat (unlike empty connections to the BinLoader).
 */
export function probeFtp(host: string, port: number, timeout = 2500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect(port, host);
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.on('error', () => {});
      if (ok) socket.end('QUIT\r\n');
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.on('error', () => done(false));
    let greeting = '';
    socket.on('data', (chunk: Buffer) => {
      greeting += chunk.toString('latin1');
      if (/^220[ -]/.test(greeting)) done(true);
      else if (greeting.includes('\n')) done(false);
    });
  });
}
