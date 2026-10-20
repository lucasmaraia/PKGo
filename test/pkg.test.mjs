import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readPkgInfo, parseSfo} from '../lib/pkg.mjs';
import {parseLoose, num} from '../lib/rpi.mjs';

function makeSfo(values) {
  const keys = Object.keys(values);
  const keyTable = Buffer.concat(keys.map(k => Buffer.from(k + '\0')));
  const data = [], index = [];
  let keyOff = 0, dataOff = 0;
  for (const k of keys) {
    const v = values[k];
    const buf = typeof v === 'number' ? Buffer.alloc(4) : Buffer.from(v + '\0');
    if (typeof v === 'number') buf.writeUInt32LE(v);
    const e = Buffer.alloc(16);
    e.writeUInt16LE(keyOff, 0);
    e.writeUInt16LE(typeof v === 'number' ? 0x0404 : 0x0204, 2);
    e.writeUInt32LE(buf.length, 4); e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(dataOff, 12);
    index.push(e); data.push(buf);
    keyOff += k.length + 1; dataOff += buf.length;
  }
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46535000, 0); head.writeUInt32LE(0x101, 4);
  const keyStart = 20 + 16 * keys.length;
  head.writeUInt32LE(keyStart, 8); head.writeUInt32LE(keyStart + keyTable.length, 12); head.writeUInt32LE(keys.length, 16);
  return Buffer.concat([head, ...index, keyTable, ...data]);
}

function makePkg(entries, contentId) {
  const tableOffset = 0x100;
  let dataOffset = tableOffset + entries.length * 32;
  const table = Buffer.alloc(entries.length * 32);
  entries.forEach((e, i) => {
    table.writeUInt32BE(e.id, i * 32); table.writeUInt32BE(e.flags || 0, i * 32 + 8);
    table.writeUInt32BE(dataOffset, i * 32 + 16); table.writeUInt32BE(e.data.length, i * 32 + 20);
    dataOffset += e.data.length;
  });
  const head = Buffer.alloc(tableOffset);
  head.writeUInt32BE(0x7f434e54, 0); head.writeUInt32BE(entries.length, 0x10); head.writeUInt32BE(tableOffset, 0x18);
  head.write(contentId, 0x40, 'ascii');
  return Buffer.concat([head, table, ...entries.map(e => e.data)]);
}

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

test('reads title, ids, version, category, firmware and icon from a PKG', async () => {
  const sfo = makeSfo({APP_VER: '01.05', CATEGORY: 'gd', SYSTEM_VER: 0x05050000, TITLE: 'Meu Jogo', TITLE_17: 'Meu Jogo BR', TITLE_ID: 'CUSA12345'});
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-')), 'game.pkg');
  fs.writeFileSync(file, makePkg([{id: 0x1000, data: sfo}, {id: 0x1200, data: png}, {id: 0x1241, data: Buffer.from('not png')}], 'UP0000-CUSA12345_00-MEUJOGO000000000'));
  const info = await readPkgInfo(file);
  assert.equal(info.title, 'Meu Jogo BR');
  assert.equal(info.titleId, 'CUSA12345');
  assert.equal(info.contentId, 'UP0000-CUSA12345_00-MEUJOGO000000000');
  assert.equal(info.version, '01.05');
  assert.equal(info.kind, 'game');
  assert.equal(info.kindLabel, 'Jogo');
  assert.equal(info.firmware, '5.05');
  assert.deepEqual(info.icon, png);
  assert.equal(info.pic, null);
});

test('skips encrypted entries and falls back to the file name', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-')), 'Sem Nome.pkg');
  fs.writeFileSync(file, makePkg([{id: 0x1200, data: png, flags: 0x80000000}], 'EP0000-CUSA99999_00-X'));
  const info = await readPkgInfo(file);
  assert.equal(info.title, 'Sem Nome');
  assert.equal(info.titleId, 'CUSA99999');
  assert.equal(info.icon, null);
});

test('rejects files that are not PS4 PKGs', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-')), 'x.pkg');
  fs.writeFileSync(file, Buffer.alloc(0x200));
  await assert.rejects(readPkgInfo(file), /Não é um PKG/);
  assert.throws(() => parseSfo(Buffer.alloc(32)), /inválido/);
});

test('parses RPI responses with bare hex numbers', () => {
  const r = parseLoose('{ "status": "success", "length_total": 0x1A2B, "transferred_total": 0x10, "error": 0 }');
  assert.equal(num(r.length_total), 0x1a2b);
  assert.equal(num(r.transferred_total), 16);
  assert.equal(num(undefined), 0);
});
