// Minimal passive-mode FTP client for the GoldHEN FTP server (anonymous, binary).
import net from 'node:net';

export class FtpClient {
  constructor(host, port = 2121, timeout = 8000) {
    this.host = host; this.port = port; this.timeout = timeout;
    this.socket = null; this.buffer = ''; this.waiters = []; this.replies = [];
  }

  async connect() {
    this.socket = net.connect(this.port, this.host);
    this.socket.setEncoding('utf8');
    this.socket.setTimeout(this.timeout, () => this.socket.destroy(new Error('tempo esgotado no FTP')));
    this.socket.on('data', chunk => this.onData(chunk));
    const closed = err => {
      for (const w of this.waiters.splice(0)) w.reject(err || new Error('conexão FTP encerrada'));
    };
    this.socket.on('error', closed);
    this.socket.on('close', () => closed());
    await new Promise((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    await this.expect(this.reply(), 2);
    const user = await this.cmd('USER anonymous');
    if (user.code === 331) await this.expect(this.cmd('PASS anonymous'), 2);
    await this.expect(this.cmd('TYPE I'), 2);
    return this;
  }

  close() {
    if (!this.socket) return;
    this.socket.end('QUIT\r\n');
    this.socket.destroy();
    this.socket = null;
  }

  onData(chunk) {
    this.buffer += chunk;
    // A reply ends with "NNN text"; multi-line replies start with "NNN-".
    let match;
    while ((match = /^(\d{3}) [^\r\n]*\r?\n/m.exec(this.buffer))) {
      const end = match.index + match[0].length;
      const text = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const reply = {code: Number(match[1]), text: text.trim()};
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(reply); else this.replies.push(reply);
    }
  }

  reply() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    return new Promise((resolve, reject) => this.waiters.push({resolve, reject}));
  }

  cmd(line) {
    this.socket.write(line + '\r\n');
    return this.reply();
  }

  async expect(promise, klass) {
    const reply = await promise;
    if (Math.floor(reply.code / 100) !== klass) throw Object.assign(new Error(`FTP: ${reply.text}`), {code: reply.code});
    return reply;
  }

  async openData() {
    const reply = await this.expect(this.cmd('PASV'), 2);
    const nums = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(reply.text);
    if (!nums) throw new Error('FTP: resposta PASV inválida');
    // GoldHEN may report an internal address; the control host is the reachable one.
    const data = net.connect(Number(nums[5]) * 256 + Number(nums[6]), this.host);
    data.setTimeout(this.timeout, () => data.destroy(new Error('tempo esgotado no FTP')));
    await new Promise((resolve, reject) => { data.once('connect', resolve); data.once('error', reject); });
    return data;
  }

  // Reads a whole transfer, or only `length` bytes from `offset` (aborting early).
  async transfer(command, {offset = 0, length = Infinity} = {}) {
    const data = await this.openData();
    if (offset) await this.expect(this.cmd(`REST ${offset}`), 3);
    const chunks = [];
    let total = 0;
    const done = new Promise((resolve, reject) => {
      data.on('data', chunk => {
        chunks.push(chunk); total += chunk.length;
        if (total >= length) { data.destroy(); resolve(); }
      });
      data.on('end', resolve);
      data.on('close', resolve);
      data.on('error', reject);
    });
    const start = await this.cmd(command);
    if (Math.floor(start.code / 100) !== 1 && Math.floor(start.code / 100) !== 2) {
      data.destroy();
      throw Object.assign(new Error(`FTP: ${start.text}`), {code: start.code});
    }
    await done;
    if (Math.floor(start.code / 100) === 1) {
      // Completion (226) or abort (426/451) reply; some servers send nothing after an early close.
      // Without it the reply stream may be out of step: callers must reconnect.
      const final = await Promise.race([this.reply(), new Promise(r => setTimeout(r, 1500, null))]);
      if (!final) this.dirty = true;
    }
    const buf = Buffer.concat(chunks);
    return length === Infinity ? buf : buf.subarray(0, length);
  }

  async list(path) {
    const buf = await this.transfer(`NLST ${path}`);
    return buf.toString('utf8').split(/\r?\n/).map(s => s.trim().split('/').pop()).filter(n => n && n !== '.' && n !== '..');
  }

  // Files and folders of `dir` from a LIST. GoldHEN's SIZE wraps above 4 GB; LIST does not.
  async entries(dir) {
    const buf = await this.transfer(`LIST ${dir}`);
    const out = [];
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      const m = /^([-d])\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$/.exec(line.trim());
      if (m && m[3] !== '.' && m[3] !== '..') out.push({name: m[3], size: Number(m[2]), dir: m[1] === 'd'});
    }
    return out;
  }

  // File sizes of `dir`, by name.
  async sizes(dir) {
    return new Map((await this.entries(dir)).filter(e => !e.dir).map(e => [e.name, e.size]));
  }

  read(path, offset, length) {
    return this.transfer(`RETR ${path}`, {offset, length});
  }
}
