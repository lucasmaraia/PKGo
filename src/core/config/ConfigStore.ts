// Settings file (config.json in the app's data folder). Unknown or invalid
// values fall back to defaults, so a hand-edited file never breaks startup.
import fs from 'node:fs';
import path from 'node:path';
import {LANGUAGES, type FolderEntry, type Language} from '@shared/types';
import {AppError} from '../errors';

export interface Config {
  ps4Ip: string;
  ftpPort: number;
  /** Port of the server the PS4 downloads PKGs from. */
  serverPort: number;
  language: Language | null;
  /** Look for new versions by itself. */
  autoUpdate: boolean;
  folders: FolderEntry[];
  files: string[];
  /** Library ids the user removed (their files stay on disk). */
  hidden: string[];
}

export const DEFAULTS: Config = {
  ps4Ip: '',
  ftpPort: 2121,
  serverPort: 8686,
  language: null,
  autoUpdate: true,
  folders: [],
  files: [],
  hidden: [],
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const isIpv4 = (value: string): boolean => IPV4.test(value);

const port = (value: unknown, fallback: number) =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) < 65536 ? (value as number) : fallback;
const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

/** Validates a parsed file, dropping what is malformed. */
export function normalize(raw: unknown): Config {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const folders = (Array.isArray(r.folders) ? r.folders : [])
    .filter((f): f is FolderEntry => !!f && typeof f === 'object' && typeof (f as FolderEntry).path === 'string')
    .map(f => ({path: f.path, recursive: f.recursive !== false}));
  return {
    ps4Ip: typeof r.ps4Ip === 'string' && isIpv4(r.ps4Ip.trim()) ? r.ps4Ip.trim() : '',
    ftpPort: port(r.ftpPort, DEFAULTS.ftpPort),
    serverPort: port(r.serverPort, DEFAULTS.serverPort),
    language: LANGUAGES.includes(r.language as Language) ? (r.language as Language) : null,
    autoUpdate: r.autoUpdate !== false,
    folders,
    files: strings(r.files),
    hidden: strings(r.hidden),
  };
}

function readJson(file: string): unknown {
  // Strip a UTF-8 BOM: Windows editors often add one.
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export class ConfigStore {
  private data: Config;

  constructor(private readonly file: string) {
    let raw: unknown = {};
    try {
      raw = readJson(file);
    } catch {
      // missing or unreadable: start with defaults
    }
    this.data = normalize(raw);
    if (!fs.existsSync(file)) this.save();
  }

  get(): Readonly<Config> {
    return this.data;
  }

  update(patch: Partial<Config>): Config {
    if (patch.ps4Ip !== undefined) {
      const ip = patch.ps4Ip.trim();
      if (ip && !isIpv4(ip)) throw new AppError('invalidIp');
      patch = {...patch, ps4Ip: ip};
    }
    if (patch.ftpPort !== undefined && port(patch.ftpPort, 0) === 0) throw new AppError('invalidPort');
    this.data = normalize({...this.data, ...patch});
    this.save();
    return this.data;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), {recursive: true});
    // Write then rename, so a crash never leaves a half-written file.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
