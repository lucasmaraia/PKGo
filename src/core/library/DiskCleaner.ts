// Plans moving library PKGs to the trash: the PKG file alone, or its whole
// folder when that folder holds only this game. A folder goes only when it has
// no subfolders, no PKG that is not being deleted too, and nothing else but
// small extras (a .txt, .nfo or picture), and it is not a protected folder:
// a library folder, the user's own folders, a drive root, or any parent of
// those.
import fs from 'node:fs';
import path from 'node:path';

export interface DeleteTarget {
  path: string;
  /** The whole folder goes, not only the PKG. */
  folder: boolean;
  /** Bytes freed. */
  size: number;
  /** Library items it removes. */
  ids: string[];
}

/** Files other than PKGs that may go with a game's folder. */
export const EXTRAS_LIMIT = 50 * 1024 * 1024;

const key = (p: string) => {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** The folder is protected, or contains a protected folder. */
function isProtected(dir: string, protectedDirs: string[]): boolean {
  const d = key(dir);
  if (path.parse(d).root === d) return true;
  return protectedDirs.some(p => {
    const k = key(p);
    return k === d || k.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
  });
}

export async function planDeletion(
  items: {id: string; path: string}[],
  protectedDirs: string[],
): Promise<DeleteTarget[]> {
  const byDir = new Map<string, {id: string; path: string}[]>();
  for (const item of items) {
    const dir = path.dirname(path.resolve(item.path));
    byDir.set(dir, [...(byDir.get(dir) ?? []), item]);
  }
  const targets: DeleteTarget[] = [];
  for (const [dir, selected] of byDir) {
    const folder = isProtected(dir, protectedDirs) ? null : await wholeFolder(dir, selected);
    if (folder) targets.push(folder);
    else {
      for (const item of selected) {
        const stat = await fs.promises.stat(item.path).catch(() => null);
        if (stat?.isFile())
          targets.push({path: path.resolve(item.path), folder: false, size: stat.size, ids: [item.id]});
      }
    }
  }
  return targets;
}

/** The folder as one target when it holds nothing but the selected game. */
async function wholeFolder(dir: string, selected: {id: string; path: string}[]): Promise<DeleteTarget | null> {
  const entries = await fs.promises.readdir(dir, {withFileTypes: true}).catch(() => null);
  if (!entries) return null;
  const chosen = new Set(selected.map(i => key(i.path)));
  let size = 0;
  let extras = 0;
  for (const e of entries) {
    if (!e.isFile()) return null;
    const file = path.join(dir, e.name);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) return null;
    size += stat.size;
    if (e.name.toLowerCase().endsWith('.pkg')) {
      if (!chosen.has(key(file))) return null;
    } else if ((extras += stat.size) > EXTRAS_LIMIT) return null;
  }
  return {path: dir, folder: true, size, ids: selected.map(i => i.id)};
}
