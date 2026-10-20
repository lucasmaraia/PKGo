import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {classify, parseSfo, readPkgInfo, titleFor} from '@core/pkg/PkgReader';
import {makePkg, makeSfo, PNG} from './helpers/pkgFixtures';

const tmpFile = (name: string) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-')), name);

describe('readPkgInfo', () => {
  it('reads ids, version, category, firmware, icon and per-language titles', async () => {
    const sfo = makeSfo({
      APP_VER: '01.05',
      CATEGORY: 'gd',
      SYSTEM_VER: 0x05050000,
      TITLE: 'My Game',
      TITLE_17: 'Meu Jogo',
      TITLE_03: 'Mi Juego',
      TITLE_ID: 'CUSA12345',
    });
    const file = tmpFile('game.pkg');
    fs.writeFileSync(
      file,
      makePkg(
        [
          {id: 0x1000, data: sfo},
          {id: 0x1200, data: PNG},
          {id: 0x1241, data: Buffer.from('not png')},
        ],
        'UP0000-CUSA12345_00-MYGAME0000000000',
      ),
    );
    const info = await readPkgInfo(file);
    expect(info.titleId).toBe('CUSA12345');
    expect(info.contentId).toBe('UP0000-CUSA12345_00-MYGAME0000000000');
    expect(info.version).toBe('01.05');
    expect(info.kind).toBe('game');
    expect(info.firmware).toBe('5.05');
    expect(info.icon).toEqual(PNG);
    expect(info.pic).toBeNull();
    expect(titleFor(info.titles, 'pt-BR')).toBe('Meu Jogo');
    expect(titleFor(info.titles, 'es')).toBe('Mi Juego');
    expect(titleFor(info.titles, 'en')).toBe('My Game');
  });

  it('skips encrypted entries and falls back to the file name', async () => {
    const file = tmpFile('No Name.pkg');
    fs.writeFileSync(file, makePkg([{id: 0x1200, data: PNG, flags: 0x80000000}], 'EP0000-CUSA99999_00-X'));
    const info = await readPkgInfo(file);
    expect(info.titles.default).toBe('No Name');
    expect(info.titleId).toBe('CUSA99999');
    expect(info.icon).toBeNull();
  });

  it('rejects files that are not PS4 PKGs', async () => {
    const file = tmpFile('x.pkg');
    fs.writeFileSync(file, Buffer.alloc(0x200));
    await expect(readPkgInfo(file)).rejects.toMatchObject({code: 'notPkg'});
    expect(() => parseSfo(Buffer.alloc(32))).toThrow(expect.objectContaining({code: 'sfoInvalid'}));
  });
});

describe('classify', () => {
  it('tells games, updates, DLC and apps apart', () => {
    expect(classify('gd', 'CUSA00486')).toBe('game');
    expect(classify('gd', 'PLAS10000')).toBe('game');
    expect(classify('gp', 'CUSA00486')).toBe('patch');
    expect(classify('gpc', 'CUSA00486')).toBe('patch');
    expect(classify('ac', 'CUSA00486')).toBe('dlc');
    expect(classify('gde', 'NPXS39041')).toBe('app');
    expect(classify(null, null)).toBe('other');
  });

  it('treats homebrew packaged as a game ("gd") as an app', () => {
    for (const id of ['LAPY20001', 'ITEM00001', 'FLTZ00003', 'APOL00004']) expect(classify('gd', id)).toBe('app');
  });
});
