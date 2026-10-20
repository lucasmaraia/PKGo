// The PKGs on this PC: files from the configured folders (optionally with all
// their subfolders) plus files added one by one, minus the ones hidden.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type {ErrorInfo, FolderEntry, ScanState} from '@shared/types';
import {toErrorInfo} from '../errors';
import {readPkgInfo, type PkgInfo} from '../pkg/PkgReader';

export interface LibraryEntry {
  id: string;
  path: string;
  name: string;
  size: number;
  mtime: number;
  info: Partial<PkgInfo>;
  error: ErrorInfo | null;
}

export interface LibrarySources {
  folders: FolderEntry[];
  files: string[];
  hidden: string[];
}

/** Stable id for a file path (case-insensitive, like Windows paths). */
export const pkgId = (file: string): string =>
  crypto.createHash('sha1').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 12);

// Folders that never hold user PKGs and can be huge or unreadable.
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git']);

const skipDir = (name: string) => name.startsWith('.') || SKIP_DIRS.has(name.toLowerCase());

/**
 * Collects *.pkg files under `dir`. With `recursive`, walks every subfolder,
 * following links but visiting each real folder once (no loops).
 */
export async function findPkgs(
  dir: string,
  recursive: boolean,
  out: Set<string>,
  onFolder?: () => void,
  visited = new Set<string>(),
): Promise<void> {
  let real: string;
  try {
    real = await fsp.realpath(dir);
  } catch {
    return;
  }
  if (visited.has(real)) return;
  visited.add(real);
  onFolder?.();
  let entries;
  try {
    entries = await fsp.readdir(dir, {withFileTypes: true});
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    let isFile = e.isFile();
    if (e.isSymbolicLink()) {
      const st = await fsp.stat(full).catch(() => null);
      isDir = !!st?.isDirectory();
      isFile = !!st?.isFile();
    }
    if (isFile && e.name.toLowerCase().endsWith('.pkg')) out.add(path.resolve(full));
    else if (isDir && recursive && !skipDir(e.name)) await findPkgs(full, true, out, onFolder, visited);
  }
}

export class LibraryService {
  private entries = new Map<string, LibraryEntry>();
  private scanning: Promise<void> | null = null;
  readonly scan: ScanState = {active: false, folders: 0, found: 0, missing: []};

  constructor(
    private readonly sources: () => LibrarySources,
    private readonly onChange: () => void,
  ) {}

  get items(): LibraryEntry[] {
    return [...this.entries.values()];
  }

  get(id: string): LibraryEntry | undefined {
    return this.entries.get(id);
  }

  delete(id: string): void {
    this.entries.delete(id);
    this.onChange();
  }

  /** Rescans all sources; concurrent calls share the same scan. */
  rescan(): Promise<void> {
    this.scanning ??= this.doScan().finally(() => {
      this.scanning = null;
      this.scan.active = false;
      this.onChange();
    });
    return this.scanning;
  }

  private async doScan(): Promise<void> {
    const {folders, files, hidden} = this.sources();
    Object.assign(this.scan, {active: true, folders: 0, found: 0, missing: []});
    this.onChange();
    const paths = new Set(files.map(f => path.resolve(f)));
    let lastNotify = 0;
    const onFolder = () => {
      this.scan.folders++;
      // Big trees: report progress a few times per second, not per folder.
      if (Date.now() - lastNotify > 250) {
        lastNotify = Date.now();
        this.scan.found = paths.size;
        this.onChange();
      }
    };
    for (const folder of folders) {
      const exists = await fsp.stat(folder.path).then(
        s => s.isDirectory(),
        () => false,
      );
      if (exists) await findPkgs(folder.path, folder.recursive, paths, onFolder);
      else this.scan.missing.push(folder.path);
    }

    const seen = new Set<string>();
    for (const file of paths) {
      const id = pkgId(file);
      if (hidden.includes(id)) continue;
      const st = await fsp.stat(file).catch(() => null);
      if (!st) continue;
      seen.add(id);
      const old = this.entries.get(id);
      if (old && old.size === st.size && old.mtime === st.mtimeMs) continue;
      let info: Partial<PkgInfo> = {};
      let error: ErrorInfo | null = null;
      try {
        info = await readPkgInfo(file);
      } catch (e) {
        error = toErrorInfo(e);
      }
      this.entries.set(id, {id, path: file, name: path.basename(file), size: st.size, mtime: st.mtimeMs, info, error});
      this.onChange();
    }
    for (const id of this.entries.keys()) if (!seen.has(id)) this.entries.delete(id);
    this.scan.found = seen.size;
  }
}
