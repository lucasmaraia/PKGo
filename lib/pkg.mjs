// Reads metadata (param.sfo, icon0.png, pic1.png) from a PS4 PKG without
// loading the whole file: PKGs can be tens of gigabytes.
import fsp from 'node:fs/promises';
import path from 'node:path';

const PKG_MAGIC = 0x7f434e54;
const ENTRY_PARAM_SFO = 0x1000;
const ENTRY_ICON0 = 0x1200;
const ENTRY_PIC0 = 0x1220;
const ENTRY_PIC1 = 0x1241;
const MAX_ENTRY_SIZE = 16 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function cString(buf, start, end = buf.length) {
  const zero = buf.indexOf(0, start);
  return buf.toString('utf8', start, zero >= 0 && zero < end ? zero : end);
}

export function parseSfo(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46535000) throw new Error('param.sfo inválido');
  const keyStart = buf.readUInt32LE(8), dataStart = buf.readUInt32LE(12), count = buf.readUInt32LE(16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const base = 20 + i * 16;
    if (base + 16 > buf.length) break;
    const key = cString(buf, keyStart + buf.readUInt16LE(base));
    const fmt = buf.readUInt16LE(base + 2), len = buf.readUInt32LE(base + 4);
    const data = dataStart + buf.readUInt32LE(base + 12);
    if (data + len > buf.length) continue;
    if (fmt === 0x0404) out[key] = buf.readUInt32LE(data);
    else if (fmt === 0x0204 || fmt === 0x0004) out[key] = cString(buf, data, data + len);
  }
  return out;
}

const KINDS = {gd: ['game', 'Jogo'], gp: ['patch', 'Atualização'], ac: ['dlc', 'DLC'], gde: ['app', 'App'], gda: ['app', 'App']};

function firmware(value) {
  if (!value) return null;
  const major = (value >>> 24) & 0xff, minor = (value >>> 16) & 0xff;
  return `${major.toString(16)}.${minor.toString(16).padStart(2, '0')}`;
}

export async function readPkgInfo(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const read = async (offset, length) => {
      const buf = Buffer.alloc(length);
      const {bytesRead} = await fh.read(buf, 0, length, offset);
      if (bytesRead !== length) throw new Error('PKG truncado');
      return buf;
    };
    return await readPkgMeta(read, path.basename(file, path.extname(file)));
  } finally {
    await fh.close();
  }
}

// `read(offset, length)` must return exactly `length` bytes. Works for local
// files and for ranged FTP reads of PKGs installed on the console.
export async function readPkgMeta(read, fallbackTitle, {images = true} = {}) {
  const head = await read(0, 0x80);
  if (head.readUInt32BE(0) !== PKG_MAGIC) throw new Error('Não é um PKG de PS4');
  const entryCount = head.readUInt32BE(0x10), tableOffset = head.readUInt32BE(0x18);
  if (entryCount > 10000) throw new Error('Tabela do PKG inválida');
  const contentId = head.toString('ascii', 0x40, 0x40 + 36).replace(/\0.*$/s, '');
  const table = await read(tableOffset, entryCount * 32);
  const entries = new Map();
  for (let i = 0; i < entryCount; i++) {
    const b = i * 32;
    entries.set(table.readUInt32BE(b), {flags: table.readUInt32BE(b + 8), offset: table.readUInt32BE(b + 16), size: table.readUInt32BE(b + 20)});
  }
  const entry = async id => {
    const e = entries.get(id);
    // Encrypted entries cannot be shown; metadata entries are plaintext in fake PKGs.
    if (!e || (e.flags & 0x80000000) || !e.size || e.size > MAX_ENTRY_SIZE) return null;
    return read(e.offset, e.size);
  };
  const png = async (...ids) => {
    for (const id of ids) {
      const buf = await entry(id);
      if (buf && buf.subarray(0, 4).equals(PNG_MAGIC)) return buf;
    }
    return null;
  };
  const sfoBuf = await entry(ENTRY_PARAM_SFO);
  const sfo = sfoBuf ? parseSfo(sfoBuf) : {};
  const [kind, kindLabel] = KINDS[sfo.CATEGORY] || ['other', sfo.CATEGORY ? sfo.CATEGORY.toUpperCase() : 'PKG'];
  return {
    contentId,
    titleId: sfo.TITLE_ID || contentId.slice(7, 16) || null,
    // Prefer the Brazilian/Portuguese localized title when present.
    title: sfo.TITLE_17 || sfo.TITLE_07 || sfo.TITLE || fallbackTitle,
    version: sfo.APP_VER || sfo.VERSION || null,
    category: sfo.CATEGORY || null,
    kind, kindLabel,
    firmware: firmware(sfo.SYSTEM_VER),
    icon: images ? await png(ENTRY_ICON0) : null,
    pic: images ? await png(ENTRY_PIC1, ENTRY_PIC0) : null,
  };
}
