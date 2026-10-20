// Reads metadata (param.sfo, icon0.png, pic1.png) from a PS4 PKG without
// loading the whole file: PKGs can be tens of gigabytes.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {Language, PkgKind} from '@shared/types';
import {AppError} from '../errors';

const PKG_MAGIC = 0x7f434e54;
const ENTRY_PARAM_SFO = 0x1000;
const ENTRY_ICON0 = 0x1200;
const ENTRY_PIC0 = 0x1220;
const ENTRY_PIC1 = 0x1241;
const MAX_ENTRY_SIZE = 16 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Title ID prefixes Sony assigns to retail PS4 titles. Homebrew uses its own
// (LAPY, ITEM, FLTZ, APOL…) and system apps use NPXS.
const RETAIL_TITLE = /^(CUSA|PCAS|PCJS|PCKS|PLAS|PLJM|PLJS|PLKS)\d{5}$/;

/**
 * Game, update, DLC or app, from the param.sfo category and the title ID.
 * Homebrew is usually packaged with the game category ("gd"), so a "gd"
 * package only counts as a game when its title ID is a retail one.
 */
export function classify(category: string | null, titleId: string | null): PkgKind {
  if (!category) return 'other';
  if (category.startsWith('gp')) return 'patch';
  if (category === 'ac') return 'dlc';
  if (category === 'gd') return titleId && RETAIL_TITLE.test(titleId) ? 'game' : 'app';
  if (category.startsWith('gd')) return 'app';
  return 'other';
}

// param.sfo TITLE_XX keys per language, most specific first.
const TITLE_KEYS: Record<Language, string[]> = {
  'pt-BR': ['TITLE_17', 'TITLE_07'],
  en: ['TITLE_01', 'TITLE_18'],
  es: ['TITLE_20', 'TITLE_03'],
};

export type Sfo = Record<string, string | number>;

/** Title per language, plus the PKG's default title. */
export type Titles = Partial<Record<Language, string>> & {default: string};

export interface PkgInfo {
  contentId: string;
  titleId: string | null;
  titles: Titles;
  version: string | null;
  category: string | null;
  kind: PkgKind;
  firmware: string | null;
  icon: Buffer | null;
  pic: Buffer | null;
}

/** Reads exactly `length` bytes at `offset`, from a local file or over FTP. */
export type RangeReader = (offset: number, length: number) => Promise<Buffer>;

function cString(buf: Buffer, start: number, end = buf.length): string {
  const zero = buf.indexOf(0, start);
  return buf.toString('utf8', start, zero >= 0 && zero < end ? zero : end);
}

export function parseSfo(buf: Buffer): Sfo {
  if (buf.length < 20 || buf.readUInt32LE(0) !== 0x46535000) throw new AppError('sfoInvalid');
  const keyStart = buf.readUInt32LE(8);
  const dataStart = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  const out: Sfo = {};
  for (let i = 0; i < count; i++) {
    const base = 20 + i * 16;
    if (base + 16 > buf.length) break;
    const key = cString(buf, keyStart + buf.readUInt16LE(base));
    const fmt = buf.readUInt16LE(base + 2);
    const len = buf.readUInt32LE(base + 4);
    const data = dataStart + buf.readUInt32LE(base + 12);
    if (data + len > buf.length) continue;
    if (fmt === 0x0404) out[key] = buf.readUInt32LE(data);
    else if (fmt === 0x0204 || fmt === 0x0004) out[key] = cString(buf, data, data + len);
  }
  return out;
}

function firmware(value: unknown): string | null {
  if (typeof value !== 'number' || !value) return null;
  const major = (value >>> 24) & 0xff;
  const minor = (value >>> 16) & 0xff;
  return `${major.toString(16)}.${minor.toString(16).padStart(2, '0')}`;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

export function sfoTitles(sfo: Sfo, fallback: string): Titles {
  const titles: Titles = {default: text(sfo.TITLE) || fallback};
  for (const [lang, keys] of Object.entries(TITLE_KEYS) as [Language, string[]][]) {
    const title = keys.map(k => text(sfo[k])).find(Boolean);
    if (title) titles[lang] = title;
  }
  return titles;
}

/** The title to show in `language`, falling back to the PKG's default. */
export const titleFor = (titles: Titles, language: Language): string => titles[language] || titles.default;

export async function readPkgMeta(
  read: RangeReader,
  fallbackTitle: string,
  {images = true}: {images?: boolean} = {},
): Promise<PkgInfo> {
  const head = await read(0, 0x80);
  if (head.readUInt32BE(0) !== PKG_MAGIC) throw new AppError('notPkg');
  const entryCount = head.readUInt32BE(0x10);
  const tableOffset = head.readUInt32BE(0x18);
  if (entryCount > 10000) throw new AppError('pkgTableInvalid');
  const contentId = head.toString('ascii', 0x40, 0x40 + 36).replace(/\0.*$/s, '');
  const table = await read(tableOffset, entryCount * 32);
  const entries = new Map<number, {flags: number; offset: number; size: number}>();
  for (let i = 0; i < entryCount; i++) {
    const b = i * 32;
    entries.set(table.readUInt32BE(b), {
      flags: table.readUInt32BE(b + 8),
      offset: table.readUInt32BE(b + 16),
      size: table.readUInt32BE(b + 20),
    });
  }
  const entry = async (id: number): Promise<Buffer | null> => {
    const e = entries.get(id);
    // Encrypted entries cannot be shown; metadata entries are plaintext in fake PKGs.
    if (!e || e.flags & 0x80000000 || !e.size || e.size > MAX_ENTRY_SIZE) return null;
    return read(e.offset, e.size);
  };
  const png = async (...ids: number[]): Promise<Buffer | null> => {
    for (const id of ids) {
      const buf = await entry(id);
      if (buf && buf.subarray(0, 4).equals(PNG_MAGIC)) return buf;
    }
    return null;
  };
  const sfoBuf = await entry(ENTRY_PARAM_SFO);
  const sfo = sfoBuf ? parseSfo(sfoBuf) : {};
  const category = text(sfo.CATEGORY);
  const titleId = text(sfo.TITLE_ID) || contentId.slice(7, 16) || null;
  return {
    contentId,
    titleId,
    titles: sfoTitles(sfo, fallbackTitle),
    version: text(sfo.APP_VER) || text(sfo.VERSION),
    category,
    kind: classify(category, titleId),
    firmware: firmware(sfo.SYSTEM_VER),
    icon: images ? await png(ENTRY_ICON0) : null,
    pic: images ? await png(ENTRY_PIC1, ENTRY_PIC0) : null,
  };
}

export async function readPkgInfo(file: string): Promise<PkgInfo> {
  const fh = await fsp.open(file, 'r');
  try {
    const read: RangeReader = async (offset, length) => {
      const buf = Buffer.alloc(length);
      const {bytesRead} = await fh.read(buf, 0, length, offset);
      if (bytesRead !== length) throw new AppError('pkgTruncated');
      return buf;
    };
    return await readPkgMeta(read, path.basename(file, path.extname(file)));
  } finally {
    await fh.close();
  }
}
