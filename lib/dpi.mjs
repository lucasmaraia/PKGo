// Installs PKGs without the Remote Package Installer: a payload sent to the
// GoldHEN BinLoader (port 9090) registers the download with the system, like
// the installer app does. Payload and protocol come from DirectPackageInstaller
// (marcussacana, GPL-3.0); see payload/README.md.
//
// The payload connects back to this PC and waits for one package per
// connection: u32 1, then url, name, content ID and package type as
// u32-length strings, u64 size and an optional icon (u32 length + PNG).
// After registering it reconnects for the next one; u32 0 makes it exit.
import net from 'node:net';
import fs from 'node:fs';

const MARKER = Buffer.alloc(6, 0xb4);

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
function str(s, max) {
  const data = Buffer.from(s || '', 'utf8');
  if (data.length >= max) throw new Error('texto longo demais para o payload');
  return Buffer.concat([u32(data.length), data]);
}

// Builds the message the payload reads in get_pkg_info().
export function packageMessage({url, name, contentId, type, size, icon}) {
  const sizeBuf = Buffer.alloc(8); sizeBuf.writeBigUInt64LE(BigInt(size));
  return Buffer.concat([
    u32(1), str(url, 0x800), str(name, 0x259), str(contentId, 0x30), str(type, 0x10), sizeBuf,
    icon?.length ? Buffer.concat([u32(icon.length), icon]) : u32(0),
  ]);
}

// Writes the PC address into the payload, where it holds 6 bytes of 0xB4.
export function patchPayload(payload, pcIp, port) {
  const at = payload.indexOf(MARKER);
  if (at < 0) throw new Error('payload sem o espaço para o endereço do PC');
  const out = Buffer.from(payload);
  pcIp.split('.').forEach((n, i) => { out[at + i] = Number(n); });
  out.writeUInt16BE(port, at + 4);
  return out;
}

// GoldHEN listens on 9090; 9021 and 9020 are used by other payload loaders.
const LOADER_PORTS = [9090, 9021, 9020];

async function sendToLoader(ps4Ip, payload, ports) {
  for (const port of ports) {
    const sent = await new Promise(resolve => {
      const sock = net.connect(port, ps4Ip);
      sock.setTimeout(5000, () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(false));
      sock.once('connect', () => sock.end(payload, () => resolve(true)));
    });
    if (sent) return;
  }
  throw new Error('o BinLoader do GoldHEN não está aceitando payloads. No PS4, abra Configurações > GoldHEN e '
    + 'desative e ative de novo o BinLoader Server (ou reinicie o PS4 e carregue o GoldHEN)');
}

// Runs payload/uninstall.bin once: it connects back, gets what to remove and
// answers with the system results (init, uninstall). Request: u32 what
// (1 = game, 2 = update) + 9-character title ID.
export async function uninstallWithPayload({payloadPath, ps4Ip, pcIp, titleId, what, loaderPorts = LOADER_PORTS}) {
  if (!/^[A-Z]{4}\d{5}$/.test(titleId)) throw new Error('título inválido');
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  try {
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('o payload não respondeu')), 20000);
      server.on('connection', sock => {
        if (sock.remoteAddress?.replace(/^::ffff:/, '') !== ps4Ip) return sock.destroy();
        clearTimeout(timer); resolve(sock);
      });
    });
    await sendToLoader(ps4Ip, patchPayload(fs.readFileSync(payloadPath), pcIp, server.address().port), loaderPorts);
    const sock = await connected;
    return await new Promise((resolve, reject) => {
      const chunks = [];
      sock.setTimeout(120000, () => sock.destroy(new Error('o PS4 não respondeu a tempo')));
      sock.on('data', c => chunks.push(c));
      sock.on('error', reject);
      sock.on('close', () => {
        const reply = Buffer.concat(chunks);
        if (reply.length < 8) return reject(new Error('o payload encerrou sem responder'));
        resolve({init: reply.readInt32LE(0), result: reply.readInt32LE(4)});
      });
      sock.write(Buffer.concat([u32(what === 'patch' ? 2 : 1), Buffer.from(titleId, 'ascii')]));
    });
  } finally {
    server.close();
  }
}

export class DpiInstaller {
  constructor(payloadPath, loaderPorts = LOADER_PORTS) {
    this.payloadPath = payloadPath;
    this.loaderPorts = loaderPorts;
    this.idle = [];      // payload connections waiting for a package
    this.waiters = [];
    this.server = null;
    this.ps4Ip = null;
  }

  get available() { return fs.existsSync(this.payloadPath); }

  async listen() {
    if (this.server) return;
    const server = net.createServer(sock => {
      // Only the console may talk to us here.
      if (sock.remoteAddress?.replace(/^::ffff:/, '') !== this.ps4Ip) return sock.destroy();
      sock.on('error', () => {});
      sock.on('close', () => { this.idle = this.idle.filter(s => s !== sock); });
      const waiter = this.waiters.shift();
      if (waiter) waiter(sock); else this.idle.push(sock);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', resolve);
    });
    this.server = server;
  }

  nextConnection(timeout) {
    const sock = this.idle.shift();
    if (sock) return Promise.resolve(sock);
    return new Promise((resolve, reject) => {
      const waiter = s => { clearTimeout(timer); resolve(s); };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w !== waiter);
        reject(new Error('o payload não respondeu. Verifique se o BinLoader está ativado no GoldHEN'));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  sendPayload(ps4Ip, pcIp) {
    const payload = patchPayload(fs.readFileSync(this.payloadPath), pcIp, this.server.address().port);
    return sendToLoader(ps4Ip, payload, this.loaderPorts);
  }

  // Sends one package; starts the payload first when none is waiting.
  async install({ps4Ip, pcIp, ...pkg}) {
    this.ps4Ip = ps4Ip;
    await this.listen();
    const message = packageMessage(pkg);
    if (!this.idle.length && !this.waiters.length) await this.sendPayload(ps4Ip, pcIp);
    const sock = await this.nextConnection(20000);
    await new Promise((resolve, reject) => {
      sock.once('error', reject);
      sock.end(message, resolve);
    });
  }

  // Lets a waiting payload exit cleanly instead of failing on a dropped connection.
  close() {
    for (const sock of this.idle.splice(0)) sock.end(u32(0));
    this.server?.close();
  }
}
