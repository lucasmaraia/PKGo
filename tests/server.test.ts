import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {PkgFileServer} from '@core/server/PkgFileServer';

const id = 'abcdef012345';
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srv-')), 'game.pkg');
const content = Buffer.from('0123456789abcdefghij');
let server: PkgFileServer;
let base: string;

beforeAll(async () => {
  fs.writeFileSync(file, content);
  server = new PkgFileServer(wanted => (wanted === id ? {id, path: file, size: content.length} : undefined));
  // Port 0: any free port.
  const port = await server.listen(0);
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => server.close());

describe('PkgFileServer', () => {
  it('serves library files with range support', async () => {
    const res = await fetch(`${base}/pkg/${id}.pkg`, {headers: {Range: 'bytes=10-14'}});
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(`bytes 10-14/${content.length}`);
    expect(await res.text()).toBe('abcde');
    expect(server.served.bytes(id)).toBe(5);
  });

  it('ignores query parameters added by the PS4 download service', async () => {
    const res = await fetch(`${base}/pkg/${id}.pkg?product=ps4&country=BR`, {method: 'HEAD'});
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(content.length));
  });

  it('serves nothing else', async () => {
    for (const url of ['/pkg/000000000000.pkg', '/config.json', '/pkg/../game.pkg', '/']) {
      expect((await fetch(base + url)).status, url).toBe(404);
    }
  });

  it('rejects ranges outside the file', async () => {
    const res = await fetch(`${base}/pkg/${id}.pkg`, {headers: {Range: 'bytes=100-'}});
    expect(res.status).toBe(416);
  });
});
