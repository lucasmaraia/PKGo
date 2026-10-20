// Installs and uninstalls through payloads sent to the GoldHEN BinLoader.
//
// Install: payload from DirectPackageInstaller (marcussacana, GPL-3.0). It
// connects back to this PC and waits for one package per connection: u32 1,
// then url, name, content ID and package type as u32-length strings, u64 size
// and an optional icon (u32 length + PNG). After registering the download it
// reconnects for the next one; u32 0 makes it exit. See payloads/README.md.
//
// Uninstall: our payload (payloads/uninstall.c). It connects back, reads
// u32 what (1 = game, 2 = update) + a 9-character title ID and answers with
// two i32: the system init and uninstall results.
import fs from 'node:fs';
import net from 'node:net';
import type {UninstallTarget} from '@shared/types';
import {AppError} from '../errors';

/** GoldHEN listens on 9090; 9021 and 9020 are used by other payload loaders. */
export const LOADER_PORTS = [9090, 9021, 9020];

const MARKER = Buffer.alloc(6, 0xb4);
const TITLE_ID = /^[A-Z]{4}\d{5}$/;

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

/** A u32-length string that fits the payload's `max`-byte buffer (with its NUL). */
function str(value: string, max: number, truncate = false): Buffer {
  let data = Buffer.from(value || '', 'utf8');
  if (data.length >= max) {
    if (!truncate) throw new AppError('payloadTextTooLong');
    // Cut whole characters so the name stays valid UTF-8.
    let text = value;
    while (Buffer.byteLength(text, 'utf8') >= max) text = text.slice(0, -1);
    data = Buffer.from(text, 'utf8');
  }
  return Buffer.concat([u32(data.length), data]);
}

export interface PackageRequest {
  url: string;
  name: string;
  contentId: string;
  /** "PS4" + param.sfo category, e.g. PS4GD, PS4GP, PS4AC. */
  type: string;
  size: number;
  icon?: Buffer | null;
}

/** Builds the message the install payload reads in get_pkg_info(). */
export function packageMessage({url, name, contentId, type, size, icon}: PackageRequest): Buffer {
  const sizeBuf = Buffer.alloc(8);
  sizeBuf.writeBigUInt64LE(BigInt(size));
  return Buffer.concat([
    u32(1),
    str(url, 0x800),
    str(name, 0x259, true),
    str(contentId, 0x30),
    str(type, 0x10),
    sizeBuf,
    icon?.length ? Buffer.concat([u32(icon.length), icon]) : u32(0),
  ]);
}

/** Writes the PC address into the payload, where it holds 6 bytes of 0xB4. */
export function patchPayload(payload: Buffer, pcIp: string, port: number): Buffer {
  const at = payload.indexOf(MARKER);
  if (at < 0) throw new AppError('payloadInvalid');
  const out = Buffer.from(payload);
  pcIp.split('.').forEach((n, i) => {
    out[at + i] = Number(n);
  });
  out.writeUInt16BE(port, at + 4);
  return out;
}

async function sendToLoader(ps4Ip: string, payload: Buffer, ports: number[]): Promise<void> {
  for (const port of ports) {
    const sent = await new Promise<boolean>(resolve => {
      const sock = net.connect(port, ps4Ip);
      sock.setTimeout(5000, () => {
        sock.destroy();
        resolve(false);
      });
      sock.once('error', () => resolve(false));
      sock.once('connect', () => sock.end(payload, () => resolve(true)));
    });
    if (sent) return;
  }
  throw new AppError('binloaderUnavailable');
}

const sameHost = (sock: net.Socket, ip: string) => sock.remoteAddress?.replace(/^::ffff:/, '') === ip;

function listen(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
}

/** Keeps the install payload running and hands it one package at a time. */
export class InstallPayload {
  private idle: net.Socket[] = [];
  private waiters: ((sock: net.Socket) => void)[] = [];
  private server: net.Server | null = null;
  private ps4Ip = '';

  constructor(
    private readonly payloadPath: string,
    public loaderPorts: number[] = LOADER_PORTS,
  ) {}

  get available(): boolean {
    return fs.existsSync(this.payloadPath);
  }

  private async ensureServer(): Promise<net.Server> {
    if (this.server) return this.server;
    const server = net.createServer(sock => {
      // Only the console may talk to us here.
      if (!sameHost(sock, this.ps4Ip)) return sock.destroy();
      sock.on('error', () => {});
      sock.on('close', () => {
        this.idle = this.idle.filter(s => s !== sock);
      });
      const waiter = this.waiters.shift();
      if (waiter) waiter(sock);
      else this.idle.push(sock);
    });
    await listen(server);
    this.server = server;
    return server;
  }

  private nextConnection(timeout: number): Promise<net.Socket> {
    const sock = this.idle.shift();
    if (sock) return Promise.resolve(sock);
    return new Promise((resolve, reject) => {
      const waiter = (s: net.Socket) => {
        clearTimeout(timer);
        resolve(s);
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new AppError('payloadNoAnswer'));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  /** Sends one package; starts the payload first when none is waiting. */
  async install(ps4Ip: string, pcIp: string, pkg: PackageRequest): Promise<void> {
    this.ps4Ip = ps4Ip;
    const server = await this.ensureServer();
    const message = packageMessage(pkg);
    if (!this.idle.length && !this.waiters.length) {
      const port = (server.address() as net.AddressInfo).port;
      await sendToLoader(ps4Ip, patchPayload(fs.readFileSync(this.payloadPath), pcIp, port), this.loaderPorts);
    }
    const sock = await this.nextConnection(20000);
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.end(message, () => resolve());
    });
  }

  /** Lets a waiting payload exit cleanly instead of failing on a dropped connection. */
  async close(): Promise<void> {
    await Promise.all(this.idle.splice(0).map(sock => new Promise<void>(resolve => sock.end(u32(0), () => resolve()))));
    this.server?.close();
    this.server = null;
  }
}

export interface UninstallResult {
  init: number;
  result: number;
}

/** Runs the uninstall payload once and returns the system results. */
export async function uninstallWithPayload(options: {
  payloadPath: string;
  ps4Ip: string;
  pcIp: string;
  titleId: string;
  what: UninstallTarget;
  loaderPorts?: number[];
}): Promise<UninstallResult> {
  const {payloadPath, ps4Ip, pcIp, titleId, what, loaderPorts = LOADER_PORTS} = options;
  if (!TITLE_ID.test(titleId)) throw new AppError('titleIdInvalid');
  const server = net.createServer();
  await listen(server);
  try {
    const connected = new Promise<net.Socket>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AppError('payloadNoAnswer')), 20000);
      server.on('connection', sock => {
        if (!sameHost(sock, ps4Ip)) return sock.destroy();
        clearTimeout(timer);
        resolve(sock);
      });
    });
    const port = (server.address() as net.AddressInfo).port;
    await sendToLoader(ps4Ip, patchPayload(fs.readFileSync(payloadPath), pcIp, port), loaderPorts);
    const sock = await connected;
    return await new Promise<UninstallResult>((resolve, reject) => {
      const chunks: Buffer[] = [];
      sock.setTimeout(120000, () => sock.destroy(new AppError('payloadTimeout')));
      sock.on('data', (c: Buffer) => chunks.push(c));
      sock.on('error', reject);
      sock.on('close', () => {
        const reply = Buffer.concat(chunks);
        if (reply.length < 8) return reject(new AppError('payloadNoReply'));
        resolve({init: reply.readInt32LE(0), result: reply.readInt32LE(4)});
      });
      sock.write(Buffer.concat([u32(what === 'patch' ? 2 : 1), Buffer.from(titleId, 'ascii')]));
    });
  } finally {
    server.close();
  }
}
