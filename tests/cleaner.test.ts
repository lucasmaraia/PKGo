import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {EXTRAS_LIMIT, planDeletion} from '@core/library/DiskCleaner';

describe('planDeletion', () => {
  let root: string;
  const file = (rel: string, size = 10) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.writeFileSync(p, Buffer.alloc(size));
    return p;
  };
  const sparse = (rel: string, size: number) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), {recursive: true});
    fs.closeSync(fs.openSync(p, 'w'));
    fs.truncateSync(p, size);
    return p;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaner-'));
  });
  afterEach(() => fs.rmSync(root, {recursive: true, force: true}));

  it("takes a game's own folder, with its small extras", async () => {
    const pkg = file('lib/Hotline Miami/game.pkg', 100);
    file('lib/Hotline Miami/readme.nfo', 5);
    const plan = await planDeletion([{id: 'a', path: pkg}], [path.join(root, 'lib')]);
    expect(plan).toEqual([{path: path.join(root, 'lib', 'Hotline Miami'), folder: true, size: 105, ids: ['a']}]);
  });

  it('takes a shared folder only when every PKG in it goes', async () => {
    const game = file('lib/Game/game.pkg');
    const patch = file('lib/Game/patch.pkg');
    const lib = [path.join(root, 'lib')];
    expect((await planDeletion([{id: 'g', path: game}], lib))[0]).toMatchObject({path: game, folder: false});
    const both = await planDeletion(
      [
        {id: 'g', path: game},
        {id: 'p', path: patch},
      ],
      lib,
    );
    expect(both).toEqual([{path: path.join(root, 'lib', 'Game'), folder: true, size: 20, ids: ['g', 'p']}]);
  });

  it('keeps folders with subfolders or large other files', async () => {
    const a = file('lib/A/a.pkg');
    fs.mkdirSync(path.join(root, 'lib/A/saves'));
    const b = file('lib/B/b.pkg');
    sparse('lib/B/movie.mkv', EXTRAS_LIMIT + 1);
    const plan = await planDeletion(
      [
        {id: 'a', path: a},
        {id: 'b', path: b},
      ],
      [path.join(root, 'lib')],
    );
    expect(plan.map(t => [t.path, t.folder])).toEqual([
      [a, false],
      [b, false],
    ]);
  });

  it('never takes a protected folder or a parent of one', async () => {
    // The PKG sits right in a library folder (like Downloads).
    const loose = file('Downloads/loose.pkg');
    // A folder holding a protected one.
    const parent = file('Users/game.pkg');
    const plan = await planDeletion(
      [
        {id: 'l', path: loose},
        {id: 'p', path: parent},
      ],
      [path.join(root, 'Downloads'), path.join(root, 'Users', 'me')],
    );
    expect(plan.every(t => !t.folder)).toBe(true);
    expect(plan.map(t => t.path)).toEqual([loose, parent]);
  });

  it('skips files that are gone', async () => {
    expect(await planDeletion([{id: 'x', path: path.join(root, 'missing', 'x.pkg')}], [])).toEqual([]);
  });
});
