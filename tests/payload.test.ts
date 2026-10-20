import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {InstallPayload, packageMessage, patchPayload, uninstallWithPayload} from '@core/payload/PayloadClient';

function fakePayloadFile(name: string): string {
  const file = path.join(os.tmpdir(), `${name}-${process.pid}.bin`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('code'), Buffer.alloc(6, 0xb4)]));
  return file;
}

/** Reads what the install payload reads in get_pkg_info(). */
function parseMessage(buf: Buffer) {
  let at = 0;
  const u32 = () => {
    const v = buf.readUInt32LE(at);
    at += 4;
    return v;
  };
  const str = () => {
    const n = u32();
    const s = buf.toString('utf8', at, at + n);
    at += n;
    return s;
  };
  const out = {flag: u32(), url: str(), name: str(), contentId: str(), type: str(), size: 0n, iconLength: 0};
  out.size = buf.readBigUInt64LE(at);
  at += 8;
  out.iconLength = u32();
  return out;
}

/** Fake GoldHEN BinLoader: receives the payload and "runs" it by connecting back. */
function fakeLoader(onRun: (port: number, bin: Buffer) => void): Promise<number> {
  return new Promise(resolve => {
    const loader = net.createServer(sock => {
      const chunks: Buffer[] = [];
      sock.on('data', c => chunks.push(c));
      sock.on('end', () => {
        loader.close();
        const bin = Buffer.concat(chunks);
        onRun(bin.readUInt16BE(8), bin);
      });
    });
    loader.listen(0, '127.0.0.1', () => resolve((loader.address() as net.AddressInfo).port));
  });
}

describe('patchPayload', () => {
  it('writes the PC address over the 0xB4 marker', () => {
    const payload = Buffer.concat([Buffer.from('head'), Buffer.alloc(6, 0xb4), Buffer.from('tail')]);
    const out = patchPayload(payload, '192.168.0.20', 0x1f90);
    expect([...out.subarray(4, 10)]).toEqual([192, 168, 0, 20, 0x1f, 0x90]);
    expect(payload[4]).toBe(0xb4);
  });

  it('rejects files without the marker', () => {
    expect(() => patchPayload(Buffer.from('nothing'), '1.2.3.4', 1)).toThrow(
      expect.objectContaining({code: 'payloadInvalid'}),
    );
  });
});

describe('packageMessage', () => {
  it('truncates long names to whole characters', () => {
    const msg = parseMessage(
      packageMessage({url: 'http://x/a.pkg', name: 'é'.repeat(400), contentId: 'ID', type: 'PS4GD', size: 1}),
    );
    expect(Buffer.byteLength(msg.name)).toBeLessThan(0x259);
    expect(msg.name).toMatch(/^é+$/);
  });
});

describe('InstallPayload', () => {
  it('sends the payload, then the package to the connection it opens', async () => {
    const file = fakePayloadFile('install');
    let resolveMessage!: (v: {ip: string; message: ReturnType<typeof parseMessage>}) => void;
    const received = new Promise<{ip: string; message: ReturnType<typeof parseMessage>}>(r => (resolveMessage = r));
    const loaderPort = await fakeLoader((port, bin) => {
      const back = net.connect(port, '127.0.0.1');
      const msg: Buffer[] = [];
      back.on('data', c => msg.push(c));
      back.on('end', () =>
        resolveMessage({ip: [...bin.subarray(4, 8)].join('.'), message: parseMessage(Buffer.concat(msg))}),
      );
    });
    const payload = new InstallPayload(file, [loaderPort]);
    try {
      await payload.install('127.0.0.1', '127.0.0.1', {
        url: 'http://127.0.0.1:8686/pkg/abc.pkg',
        name: 'Game',
        contentId: 'UP0000-CUSA00001_00-0000000000000000',
        type: 'PS4GD',
        size: 1234,
        icon: Buffer.from('png'),
      });
      const {ip, message} = await received;
      expect(ip).toBe('127.0.0.1');
      expect(message).toEqual({
        flag: 1,
        url: 'http://127.0.0.1:8686/pkg/abc.pkg',
        name: 'Game',
        contentId: 'UP0000-CUSA00001_00-0000000000000000',
        type: 'PS4GD',
        size: 1234n,
        iconLength: 3,
      });
    } finally {
      await payload.close();
      fs.rmSync(file, {force: true});
    }
  });

  it('explains when no BinLoader accepts the payload', async () => {
    const file = fakePayloadFile('install-offline');
    const closed = await new Promise<number>(resolve => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const port = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(port));
      });
    });
    const payload = new InstallPayload(file, [closed]);
    try {
      await expect(
        payload.install('127.0.0.1', '127.0.0.1', {url: 'u', name: 'n', contentId: 'c', type: 'PS4GD', size: 1}),
      ).rejects.toMatchObject({code: 'binloaderUnavailable'});
    } finally {
      await payload.close();
      fs.rmSync(file, {force: true});
    }
  });
});

describe('uninstallWithPayload', () => {
  it('sends the title and returns the system results', async () => {
    const file = fakePayloadFile('uninstall');
    let request: {what: number; titleId: string} | undefined;
    const loaderPort = await fakeLoader(port => {
      const back = net.connect(port, '127.0.0.1');
      back.once('data', (d: Buffer) => {
        request = {what: d.readUInt32LE(0), titleId: d.toString('ascii', 4, 13)};
        const reply = Buffer.alloc(8);
        reply.writeInt32LE(0, 0);
        reply.writeInt32LE(0x80990088 | 0, 4);
        back.end(reply);
      });
    });
    try {
      const r = await uninstallWithPayload({
        payloadPath: file,
        ps4Ip: '127.0.0.1',
        pcIp: '127.0.0.1',
        titleId: 'CUSA03587',
        what: 'patch',
        loaderPorts: [loaderPort],
      });
      expect(request).toEqual({what: 2, titleId: 'CUSA03587'});
      expect(r).toEqual({init: 0, result: 0x80990088 | 0});
    } finally {
      fs.rmSync(file, {force: true});
    }
  });

  it('refuses malformed title IDs before contacting the console', async () => {
    await expect(
      uninstallWithPayload({payloadPath: 'x', ps4Ip: '1.2.3.4', pcIp: '1.2.3.5', titleId: '../etc', what: 'game'}),
    ).rejects.toMatchObject({code: 'titleIdInvalid'});
  });
});
