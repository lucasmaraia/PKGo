import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {findPkgs, LibraryService} from '@core/library/LibraryService';

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-'));
  const files = [
    'top.pkg',
    'a/one.PKG',
    'a/b/c/d/e/f/deep.pkg',
    'a/notes.txt',
    '.hidden/skip.pkg',
    '$RECYCLE.BIN/skip.pkg',
  ];
  for (const f of files) {
    fs.mkdirSync(path.join(root, path.dirname(f)), {recursive: true});
    fs.writeFileSync(path.join(root, f), 'x');
  }
  return root;
}

const names = (set: Set<string>) => [...set].map(f => path.basename(f)).sort();

describe('findPkgs', () => {
  it('finds PKGs at any depth, skipping hidden and system folders', async () => {
    const out = new Set<string>();
    await findPkgs(tree(), true, out);
    expect(names(out)).toEqual(['deep.pkg', 'one.PKG', 'top.pkg']);
  });

  it('stays in the folder itself without recursion', async () => {
    const out = new Set<string>();
    await findPkgs(tree(), false, out);
    expect(names(out)).toEqual(['top.pkg']);
  });

  it('visits each real folder once when links make a loop', async () => {
    const root = tree();
    try {
      // A junction works without admin rights on Windows.
      fs.symlinkSync(root, path.join(root, 'a', 'loop'), 'junction');
    } catch {
      return; // links not supported here
    }
    const out = new Set<string>();
    let folders = 0;
    await findPkgs(root, true, out, () => folders++);
    expect(names(out)).toEqual(['deep.pkg', 'one.PKG', 'top.pkg']);
    expect(folders).toBe(7);
  });
});

describe('LibraryService', () => {
  it('reports missing folders and lists unreadable files with an error', async () => {
    const root = tree();
    const missing = path.join(root, 'gone');
    const service = new LibraryService(
      () => ({
        folders: [
          {path: root, recursive: false},
          {path: missing, recursive: true},
        ],
        files: [],
        hidden: [],
      }),
      () => {},
    );
    await service.rescan();
    expect(service.scan.missing).toEqual([missing]);
    expect(service.scan.found).toBe(1);
    expect(service.items[0]?.error?.code).toBe('pkgTruncated');
  });
});
