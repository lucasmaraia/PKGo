// Builds minimal param.sfo and PKG files for tests.

export function makeSfo(values: Record<string, string | number>): Buffer {
  const keys = Object.keys(values);
  const keyTable = Buffer.concat(keys.map(k => Buffer.from(k + '\0')));
  const data: Buffer[] = [];
  const index: Buffer[] = [];
  let keyOff = 0;
  let dataOff = 0;
  for (const k of keys) {
    const v = values[k]!;
    const buf = typeof v === 'number' ? Buffer.alloc(4) : Buffer.from(v + '\0');
    if (typeof v === 'number') buf.writeUInt32LE(v);
    const e = Buffer.alloc(16);
    e.writeUInt16LE(keyOff, 0);
    e.writeUInt16LE(typeof v === 'number' ? 0x0404 : 0x0204, 2);
    e.writeUInt32LE(buf.length, 4);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(dataOff, 12);
    index.push(e);
    data.push(buf);
    keyOff += k.length + 1;
    dataOff += buf.length;
  }
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46535000, 0);
  head.writeUInt32LE(0x101, 4);
  const keyStart = 20 + 16 * keys.length;
  head.writeUInt32LE(keyStart, 8);
  head.writeUInt32LE(keyStart + keyTable.length, 12);
  head.writeUInt32LE(keys.length, 16);
  return Buffer.concat([head, ...index, keyTable, ...data]);
}

export interface PkgEntry {
  id: number;
  data: Buffer;
  flags?: number;
}

export function makePkg(entries: PkgEntry[], contentId: string): Buffer {
  const tableOffset = 0x100;
  let dataOffset = tableOffset + entries.length * 32;
  const table = Buffer.alloc(entries.length * 32);
  entries.forEach((e, i) => {
    table.writeUInt32BE(e.id, i * 32);
    table.writeUInt32BE(e.flags || 0, i * 32 + 8);
    table.writeUInt32BE(dataOffset, i * 32 + 16);
    table.writeUInt32BE(e.data.length, i * 32 + 20);
    dataOffset += e.data.length;
  });
  const head = Buffer.alloc(tableOffset);
  head.writeUInt32BE(0x7f434e54, 0);
  head.writeUInt32BE(entries.length, 0x10);
  head.writeUInt32BE(tableOffset, 0x18);
  head.write(contentId, 0x40, 'ascii');
  return Buffer.concat([head, table, ...entries.map(e => e.data)]);
}

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
