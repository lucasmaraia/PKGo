// PS4 PKG Sender: local web UI + LAN file server for the Remote Package Installer.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readPkgInfo} from './lib/pkg.mjs';
import {rpiCall, num, describeError} from './lib/rpi.mjs';
import {pickFiles, pickFolder} from './lib/dialogs.mjs';
import {readConsoleLibrary} from './lib/console.mjs';
import {DpiInstaller, uninstallWithPayload} from './lib/dpi.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(root, 'config.json');
const publicDir = path.join(root, 'public');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Changes whenever the server code changes, so a newer copy can replace a running one.
const codeVersion = crypto.createHash('sha1').update(['server.mjs', ...fs.readdirSync(path.join(root, 'lib')).map(f => `lib/${f}`)]
  .map(f => { const st = fs.statSync(path.join(root, f)); return `${f}:${st.size}:${st.mtimeMs}`; }).join('|')).digest('hex').slice(0, 12);
// Installs through the GoldHEN BinLoader when the Remote Package Installer is closed.
const dpi = new DpiInstaller(path.join(root, 'payload', 'dpi.bin'));
const uninstallPayload = path.join(root, 'payload', 'uninstall.bin');
const hex = code => `0x${(code >>> 0).toString(16).toUpperCase()}`;

// ---------- configuration ----------
function readJson(file) {
  // Strip a UTF-8 BOM: Windows editors often add one.
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return {}; }
}
const config = {ps4Ip: '', rpiPort: 12800, ftpPort: 2121, serverPort: 8686, folders: [], files: [], hidden: [], ...readJson(configPath)};
function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// Virtual adapters (WSL, Hyper-V, VPNs, VMs) are unreachable from the PS4.
const VIRTUAL = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Tailscale|ZeroTier|Bluetooth/i;
function lanIp() {
  const addrs = Object.entries(os.networkInterfaces()).flatMap(([name, list]) =>
    (list || []).filter(a => a.family === 'IPv4' && !a.internal).map(a => ({name, address: a.address})));
  const prefix = config.ps4Ip.split('.').slice(0, 3).join('.') + '.';
  const real = addrs.filter(a => !VIRTUAL.test(a.name));
  const pick = (config.ps4Ip && addrs.find(a => a.address.startsWith(prefix))) ||
    real.find(a => a.address.startsWith('192.168.')) || real.find(a => /^(10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) ||
    real[0] || addrs[0];
  return pick?.address || null;
}

// ---------- library ----------
const library = new Map();
const pkgId = file => crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 12);
let scanning = null;

async function walk(dir, depth, out) {
  let entries;
  try { entries = await fsp.readdir(dir, {withFileTypes: true}); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0 && !e.name.startsWith('$')) await walk(full, depth - 1, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.pkg')) out.add(path.resolve(full));
  }
}

function scan() {
  if (!scanning) scanning = doScan().finally(() => { scanning = null; });
  return scanning;
}

async function doScan() {
  const paths = new Set(config.files.map(f => path.resolve(f)));
  for (const dir of config.folders) await walk(dir, 4, paths);
  const seen = new Set();
  for (const file of paths) {
    const id = pkgId(file);
    if (config.hidden.includes(id)) continue;
    let st;
    try { st = await fsp.stat(file); } catch { continue; }
    seen.add(id);
    const old = library.get(id);
    if (old && old.size === st.size && old.mtime === st.mtimeMs) continue;
    let info = {}, error = null;
    try { info = await readPkgInfo(file); } catch (e) { error = e.message; }
    library.set(id, {id, path: file, name: path.basename(file), size: st.size, mtime: st.mtimeMs, info, error});
  }
  for (const id of library.keys()) if (!seen.has(id)) library.delete(id);
}

// Compares a PC package with what the console list says is installed.
// null = unknown (list not loaded yet, or a DLC, which is not compared).
function installState(info) {
  if (consoleLib.state !== 'ready' || !info.titleId || info.kind === 'dlc') return {installed: null};
  const c = consoleLib.items.find(i => i.titleId === info.titleId);
  if (info.kind === 'patch') {
    if (!c) return {installed: false};
    const current = c.patchVersion || c.baseVersion || '';
    return {installed: !!info.version && current >= info.version, installedVersion: current, newer: !!info.version && info.version > current};
  }
  return {installed: !!c, installedVersion: c?.version || null};
}

function publicItem(item) {
  const {info} = item;
  // Update PKGs usually have no icon; borrow the game's from the PC library.
  const iconFrom = info.icon ? item : [...library.values()].find(o => o.info.icon && o.info.titleId === info.titleId);
  return {
    iconId: iconFrom?.id || null,
    id: item.id, name: item.name, path: item.path, size: item.size, error: item.error, ...installState(info),
    title: info.title || item.name, titleId: info.titleId || null, contentId: info.contentId || null,
    version: info.version || null, kind: info.kind || 'other', kindLabel: info.kindLabel || 'PKG',
    firmware: info.firmware || null, hasIcon: !!iconFrom, hasPic: !!info.pic,
  };
}

// ---------- PS4 status ----------
const ps4 = {state: 'unknown', checkedAt: 0};
async function checkPs4() {
  if (!config.ps4Ip) { ps4.state = 'unconfigured'; return; }
  try {
    await rpiCall(config, 'is_exists', {title_id: 'CUSA00000'}, 2500);
    ps4.state = 'online';
  } catch (e) {
    // Refused/reset means the console answered but the installer app is closed
    // (or suspended in the background); a timeout means the console is unreachable.
    ps4.state = ['ECONNREFUSED', 'ECONNRESET'].includes(e.cause?.code) ? 'noinstaller' : 'offline';
  }
  ps4.checkedAt = Date.now();
}
setInterval(checkPs4, 4000);

// ---------- games installed on the PS4 (via GoldHEN FTP) ----------
const consoleLib = {state: 'idle', items: [], storage: [], done: 0, total: 0, error: null, updatedAt: 0};
const consoleCache = new Map(), consoleIcons = new Map();
let consoleLoading = null;
function refreshConsole() {
  if (!config.ps4Ip) return Promise.resolve();
  if (!consoleLoading) consoleLoading = (async () => {
    consoleLib.state = consoleLib.updatedAt ? 'ready' : 'loading';
    consoleLib.refreshing = true; consoleLib.error = null;
    try {
      const {items, storage} = await readConsoleLibrary({
        host: config.ps4Ip, port: config.ftpPort, cache: consoleCache, icons: consoleIcons,
        onProgress: (done, total) => { consoleLib.done = done; consoleLib.total = total; },
      });
      Object.assign(consoleLib, {items, storage});
      consoleLib.state = 'ready'; consoleLib.updatedAt = Date.now();
    } catch (e) {
      consoleLib.error = `Não foi possível ler o PS4 pelo FTP (${e.message}). Verifique se o GoldHEN está ativo.`;
      if (!consoleLib.updatedAt) consoleLib.state = 'error';
    } finally {
      consoleLib.refreshing = false;
      consoleLoading = null;
    }
  })();
  return consoleLoading;
}

// ---------- install queue ----------
const jobs = [];
let nextJobId = 1, pumping = false;
const ACTIVE = ['queued', 'starting', 'installing'];

function httpError(status, message) {
  return Object.assign(new Error(message), {status});
}

function enqueue(id) {
  const item = library.get(id);
  if (!item) throw httpError(404, 'PKG não encontrado na biblioteca.');
  if (item.error) throw httpError(400, `Este arquivo não pode ser instalado: ${item.error}`);
  if (jobs.some(j => j.pkgId === id && ACTIVE.includes(j.state))) throw httpError(409, 'Este PKG já está na fila.');
  const job = {id: nextJobId++, pkgId: id, title: item.info.title || item.name, state: 'queued',
    total: item.size, transferred: 0, speed: 0, eta: null, error: null, createdAt: Date.now()};
  jobs.push(job);
  pump();
  return job;
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let job;
    while ((job = jobs.find(j => j.state === 'queued'))) await runJob(job);
  } finally {
    pumping = false;
  }
}

function fail(job, message) {
  job.state = 'error'; job.error = message; job.finishedAt = Date.now();
}

async function runJob(job) {
  const item = library.get(job.pkgId);
  if (!item) return fail(job, 'O PKG foi removido da biblioteca.');
  const ip = lanIp();
  if (!ip) return fail(job, 'Não encontrei a rede local deste PC.');
  job.state = 'starting'; job.startedAt = Date.now();
  const url = `http://${ip}:${config.serverPort}/pkg/${item.id}.pkg`;
  if (ps4.state !== 'online' && dpi.available) return runDpiJob(job, item, url, ip);
  let res;
  try {
    res = await rpiCall(config, 'install', {type: 'direct', packages: [url]}, 20000);
  } catch (e) {
    return fail(job, `O PS4 não respondeu (${e.message}). Abra o Remote Package Installer no PS4.`);
  }
  if (res.status !== 'success') return fail(job, describeError(res));
  job.taskId = num(res.task_id);
  job.state = 'installing';
  let misses = 0, last = {time: Date.now(), bytes: 0};
  for (;;) {
    await sleep(1000);
    let p;
    try {
      p = await rpiCall(config, 'get_task_progress', {task_id: job.taskId}, 5000);
      misses = 0;
    } catch {
      if (++misses >= 30) return fail(job, 'A conexão com o PS4 caiu durante a instalação.');
      continue;
    }
    if (p.status !== 'success') {
      // The task disappears from the PS4 once it completes.
      if (job.total && job.transferred >= job.total * 0.99) return finish(job, item);
      return fail(job, describeError(p));
    }
    const error = num(p.error);
    if (error) return fail(job, describeError({error_code: error}));
    const total = num(p.length_total) || num(p.length) || job.total;
    const done = num(p.transferred_total) || num(p.transferred);
    const now = Date.now(), seconds = (now - last.time) / 1000;
    if (seconds > 0 && done >= last.bytes) {
      const instant = (done - last.bytes) / seconds;
      job.speed = job.speed ? job.speed * 0.7 + instant * 0.3 : instant;
    }
    last = {time: now, bytes: done};
    job.total = total; job.transferred = done;
    job.eta = num(p.rest_sec_total) || (job.speed > 0 ? (total - done) / job.speed : null);
    if (total > 0 && done >= total) return finish(job, item);
  }
}

// The payload reports errors only on the PS4 screen, so progress comes from
// the bytes this server hands to the console.
function bgftType(info) {
  return `PS4${(info.category || {game: 'gd', patch: 'gp', dlc: 'ac'}[info.kind] || 'gd').toUpperCase()}`;
}
async function runDpiJob(job, item, url, ip) {
  served.delete(item.id);
  try {
    await dpi.install({ps4Ip: config.ps4Ip, pcIp: ip, url, name: job.title, contentId: item.info.contentId || '',
      type: bgftType(item.info), size: item.size, icon: item.info.icon});
  } catch (e) {
    return fail(job, `Não consegui instalar pelo GoldHEN: ${e.message}.`);
  }
  job.state = 'installing'; job.method = 'goldhen';
  let last = {time: Date.now(), bytes: 0}, lastChange = Date.now();
  for (;;) {
    await sleep(1000);
    const done = Math.min(servedBytes(item.id), item.size), now = Date.now();
    if (done > last.bytes) lastChange = now;
    else if (now - lastChange > (done ? 180000 : 60000)) {
      return fail(job, done ? 'O PS4 parou de baixar o pacote.' : 'O PS4 não começou a baixar o pacote. Veja a notificação na tela do PS4.');
    }
    const seconds = (now - last.time) / 1000, instant = (done - last.bytes) / seconds;
    job.speed = job.speed ? job.speed * 0.7 + instant * 0.3 : instant;
    last = {time: now, bytes: done};
    job.transferred = done;
    job.eta = job.speed > 0 ? (item.size - done) / job.speed : null;
    if (done >= item.size) return finish(job, item);
  }
}

function finish(job, item) {
  job.state = 'done'; job.transferred = job.total; job.speed = 0; job.eta = 0; job.finishedAt = Date.now();
  // Give the console a moment to register the package before listing it.
  setTimeout(refreshConsole, 8000);
}

// ---------- HTTP ----------
const MIME = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml'};

function sendJson(res, status, data) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Bytes of each PKG already sent to the PS4, as merged [start, end) ranges.
const served = new Map();
function markServed(id, start, end) {
  const merged = [];
  for (const r of [...(served.get(id) || []), [start, end]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
  }
  served.set(id, merged);
}
const servedBytes = id => (served.get(id) || []).reduce((total, [s, e]) => total + e - s, 0);

// Serves a PKG to the PS4 with HTTP range support (the installer resumes in chunks).
function servePkg(req, res, item) {
  const size = item.size;
  let start = 0, end = size - 1, status = 200;
  if (req.headers.range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!m || (!m[1] && !m[2])) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); return res.end(); }
    if (!m[1]) start = Math.max(0, size - Number(m[2]));
    else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
    if (start > end || start >= size) { res.writeHead(416, {'Content-Range': `bytes */${size}`}); return res.end(); }
    status = 206;
  }
  const headers = {'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1};
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(item.path, {start, end});
  let pos = start;
  stream.on('data', chunk => { markServed(item.id, pos, pos + chunk.length); pos += chunk.length; });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

const routes = {
  'GET /api/state': async () => (lastSeen = Date.now(), polled = true, {
    version: codeVersion,
    config: {ps4Ip: config.ps4Ip, rpiPort: config.rpiPort, folders: config.folders},
    lanIp: lanIp(), ps4, dpi: dpi.available, dpiUninstall: fs.existsSync(uninstallPayload), scanning: !!scanning, console: consoleLib,
    library: [...library.values()].map(publicItem).sort((a, b) => a.title.localeCompare(b.title, 'pt-BR') || (b.version || '').localeCompare(a.version || '')),
    jobs,
  }),
  'POST /api/config': async body => {
    const ip = String(body.ps4Ip || '').trim();
    if (ip && !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw httpError(400, 'IP do PS4 inválido.');
    const port = Number(body.rpiPort) || 12800;
    if (port < 1 || port > 65535) throw httpError(400, 'Porta inválida.');
    const changed = ip !== config.ps4Ip;
    config.ps4Ip = ip; config.rpiPort = port;
    saveConfig();
    checkPs4();
    if (changed) {
      consoleCache.clear(); consoleIcons.clear();
      Object.assign(consoleLib, {state: 'idle', items: [], updatedAt: 0, error: null});
      refreshConsole();
    }
    return {ok: true};
  },
  'POST /api/console/refresh': async () => { refreshConsole(); return {ok: true}; },
  // Uses the system uninstaller (through the Remote Package Installer, or a
  // GoldHEN payload when it is closed), so the home screen and app database
  // stay consistent. Saved data is not touched.
  'POST /api/console/uninstall': async body => {
    const item = consoleLib.items.find(i => i.titleId === body.titleId);
    if (!item) throw httpError(404, 'Este item não está mais no PS4. Atualize a lista.');
    const what = body.what === 'patch' ? 'patch' : 'game';
    if (what === 'patch' && !item.patchVersion) throw httpError(400, 'Este jogo não tem atualização instalada.');
    if (what === 'game' && /remote pkg installer/i.test(item.title)) {
      throw httpError(400, 'O Remote Package Installer não pode excluir a si mesmo. Remova-o pelo menu do PS4.');
    }
    if (ps4.state !== 'online' && fs.existsSync(uninstallPayload)) {
      const ip = lanIp();
      if (!ip) throw httpError(503, 'Não encontrei a rede local deste PC.');
      let r;
      try {
        r = await uninstallWithPayload({payloadPath: uninstallPayload, ps4Ip: config.ps4Ip, pcIp: ip, titleId: item.titleId, what});
      } catch (e) {
        throw httpError(503, `Não consegui excluir pelo GoldHEN: ${e.message}.`);
      }
      if (r.result) {
        throw httpError(502, `O PS4 recusou a exclusão (código ${hex(r.result)}${r.init ? `; inicialização ${hex(r.init)}` : ''}).`);
      }
    } else {
      let res;
      try {
        res = await rpiCall(config, what === 'patch' ? 'uninstall_patch' : 'uninstall_game', {title_id: item.titleId}, 120000);
      } catch (e) {
        throw httpError(503, `O PS4 não respondeu (${e.message}). Abra o Remote Package Installer no PS4 para excluir.`);
      }
      if (res.status !== 'success') throw httpError(502, describeError(res).replace('a instalação', 'a exclusão'));
    }
    // The installer answers "success" even for unknown title IDs: confirm on the console.
    await sleep(1500);
    if (consoleLoading) await consoleLoading;
    await refreshConsole();
    const after = consoleLib.items.find(i => i.titleId === item.titleId);
    const gone = what === 'patch' ? !after?.patchVersion : !after;
    if (!gone) throw httpError(502, 'O PS4 aceitou o pedido, mas o item continua instalado. Tente excluir pelo menu do PS4.');
    return {ok: true};
  },
  'POST /api/window': async () => { openUi(); return {ok: true}; },
  // A newer copy of the app asks this one to step aside, unless a PS4 download is running.
  'POST /api/shutdown': async () => {
    if (jobs.some(j => ACTIVE.includes(j.state))) throw httpError(409, 'Há uma instalação em andamento.');
    dpi.close();
    setTimeout(() => process.exit(0), 300);
    return {ok: true};
  },
  'POST /api/add-files': async () => {
    const files = await pickFiles();
    for (const f of files) {
      if (!config.files.includes(f)) config.files.push(f);
      config.hidden = config.hidden.filter(id => id !== pkgId(f));
    }
    saveConfig(); await scan();
    return {added: files.length};
  },
  'POST /api/add-folder': async () => {
    const [folder] = await pickFolder();
    if (folder && !config.folders.includes(folder)) { config.folders.push(folder); saveConfig(); }
    await scan();
    return {folder: folder || null};
  },
  'POST /api/remove-folder': async body => {
    config.folders = config.folders.filter(f => f !== body.folder);
    saveConfig(); await scan();
    return {ok: true};
  },
  'POST /api/remove': async body => {
    const item = library.get(body.id);
    if (!item) return {ok: true};
    config.files = config.files.filter(f => path.resolve(f) !== item.path);
    if (!config.hidden.includes(item.id)) config.hidden.push(item.id);
    library.delete(item.id);
    saveConfig();
    return {ok: true};
  },
  'POST /api/rescan': async () => { await scan(); return {ok: true}; },
  'POST /api/install': async body => enqueue(String(body.id)),
  'POST /api/cancel': async body => {
    const job = jobs.find(j => j.id === body.jobId);
    if (!job || job.state !== 'queued') throw httpError(409, 'Só é possível remover itens que ainda estão aguardando.');
    jobs.splice(jobs.indexOf(job), 1);
    return {ok: true};
  },
  'POST /api/clear-finished': async () => {
    for (let i = jobs.length - 1; i >= 0; i--) if (!ACTIVE.includes(jobs[i].state)) jobs.splice(i, 1);
    return {ok: true};
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // PKG downloads are the only route the PS4 (a remote host) may use.
    const pkg = /^\/pkg\/([0-9a-f]{12})\.pkg$/.exec(url.pathname);
    if (pkg && (req.method === 'GET' || req.method === 'HEAD')) {
      const item = library.get(pkg[1]);
      if (!item) { res.writeHead(404); return res.end(); }
      return servePkg(req, res, item);
    }
    if (!isLocal(req)) { res.writeHead(403); return res.end(); }
    const image = /^\/api\/(icon|pic)\/([0-9a-f]{12})$/.exec(url.pathname);
    if (image && req.method === 'GET') {
      const buf = library.get(image[2])?.info[image[1]];
      if (!buf) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600'});
      return res.end(buf);
    }
    const consoleIcon = /^\/api\/console-icon\/([A-Z]{4}\d{5})$/.exec(url.pathname);
    if (consoleIcon && req.method === 'GET') {
      const buf = consoleIcons.get(consoleIcon[1]);
      if (!buf) { res.writeHead(404); return res.end(); }
      res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600'});
      return res.end(buf);
    }
    const handler = routes[`${req.method} ${url.pathname}`];
    if (handler) return sendJson(res, 200, await handler(req.method === 'POST' ? await readBody(req) : {}));
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(publicDir)) { res.writeHead(403); return res.end(); }
    const data = await fsp.readFile(file).catch(() => null);
    if (!data) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
    res.end(data);
  } catch (e) {
    sendJson(res, e.status || 500, {error: e.message});
  }
});

const localUrl = `http://localhost:${config.serverPort}/`;
const APP_MODE = process.argv.includes('--app');

// ---------- desktop window ----------
// --app opens the UI in its own Edge window (no tabs or address bar) with a
// dedicated profile, so the Edge process lives exactly as long as the window.
function edgePath() {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  return bases.map(b => path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(p => fs.existsSync(p));
}
let windows = 0, lastSeen = Date.now(), polled = false;
function openUi() {
  const edge = APP_MODE && edgePath();
  if (!edge) {
    spawn('cmd', ['/c', 'start', '', localUrl], {detached: true, stdio: 'ignore'}).unref();
    return;
  }
  const profile = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'PKGSender', 'janela');
  const win = spawn(edge, [`--app=${localUrl}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--window-size=1320,880'], {stdio: 'ignore'});
  windows++;
  win.on('exit', () => { if (--windows === 0) exitWhenIdle(); });
}
// Closing the window must not cut a PS4 download in progress. A window that
// is still open keeps polling /api/state (about once a minute when minimized),
// e.g. when Edge handed the launch over to an already open window.
function exitWhenIdle() {
  if (windows > 0) return;
  if (jobs.some(j => ACTIVE.includes(j.state)) || Date.now() - lastSeen < 70000) return setTimeout(exitWhenIdle, 3000);
  dpi.close();
  setTimeout(() => process.exit(0), 300);
}

let replacing = false;
server.on('error', async e => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Another copy is running. When its code is older, take its place.
  const running = await fetch(localUrl + 'api/state').then(r => r.json()).catch(() => null);
  if (!replacing && running && running.version !== codeVersion) {
    const res = await fetch(localUrl + 'api/shutdown', {method: 'POST'}).catch(() => null);
    if (res?.ok) {
      replacing = true;
      console.log('Substituindo a versão anterior do PKG Sender…');
      await sleep(1200);
      return server.listen(config.serverPort, '0.0.0.0');
    }
    console.log(res?.status === 409 ? 'A versão anterior está instalando um pacote; ela continua aberta até terminar.'
      : 'Há uma versão anterior aberta que não pôde ser substituída. Feche-a pelo Gerenciador de Tarefas (node.exe).');
  }
  // Already running: ask that instance to show its window.
  console.log(`O PKG Sender já está aberto em ${localUrl}`);
  if (APP_MODE) await fetch(localUrl + 'api/window', {method: 'POST'}).catch(() => {});
  else if (process.argv.includes('--open')) openUi();
  process.exit(0);
});
server.listen(config.serverPort, '0.0.0.0', async () => {
  console.log(`PS4 PKG Sender rodando em ${localUrl}`);
  console.log(`Endereço na rede para o PS4: ${lanIp() || 'não encontrado'}`);
  console.log('Mantenha esta janela aberta durante as instalações.');
  // After replacing an older copy, its window reloads by itself; open one only if none shows up.
  if (replacing) setTimeout(() => { if (!polled && (APP_MODE || process.argv.includes('--open'))) openUi(); }, 4000);
  else if (APP_MODE || process.argv.includes('--open')) openUi();
  checkPs4();
  refreshConsole();
  await scan();
});
