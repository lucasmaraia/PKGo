import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DpiInstaller, patchPayload, uninstallWithPayload} from '../lib/dpi.mjs';

test('patchPayload writes the PC address over the 0xB4 marker', () => {
  const payload = Buffer.concat([Buffer.from('head'), Buffer.alloc(6, 0xb4), Buffer.from('tail')]);
  const out = patchPayload(payload, '192.168.0.20', 0x1f90);
  assert.deepEqual([...out.subarray(4, 10)], [192, 168, 0, 20, 0x1f, 0x90]);
  assert.equal(payload[4], 0xb4, 'original buffer untouched');
});

// Reads what the real payload reads in get_pkg_info().
function parseMessage(buf) {
  let at = 0;
  const u32 = () => { const v = buf.readUInt32LE(at); at += 4; return v; };
  const str = () => { const n = u32(); const s = buf.toString('utf8', at, at + n); at += n; return s; };
  const out = {flag: u32(), url: str(), name: str(), contentId: str(), type: str()};
  out.size = buf.readBigUInt64LE(at); at += 8;
  out.iconLength = u32();
  return out;
}

test('install sends the payload, then the package to the connection it opens', async () => {
  const file = path.join(os.tmpdir(), `dpi-test-${process.pid}.bin`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('code'), Buffer.alloc(6, 0xb4)]));
  // Fake GoldHEN BinLoader: receives the payload and "runs" it by connecting back.
  const received = new Promise(resolve => {
    const loader = net.createServer(sock => {
      const chunks = [];
      sock.on('data', c => chunks.push(c));
      sock.on('end', () => {
        loader.close();
        const bin = Buffer.concat(chunks);
        const port = bin.readUInt16BE(8);
        const back = net.connect(port, '127.0.0.1');
        const msg = [];
        back.on('data', c => msg.push(c));
        back.on('end', () => resolve({ip: [...bin.subarray(4, 8)].join('.'), message: parseMessage(Buffer.concat(msg))}));
      });
    }).listen(0, '127.0.0.1');
    loader.on('listening', () => { dpi.loaderPorts = [loader.address().port]; });
  });
  const dpi = new DpiInstaller(file, []);
  await new Promise(r => setTimeout(r, 50));
  try {
    await dpi.install({ps4Ip: '127.0.0.1', pcIp: '127.0.0.1', url: 'http://127.0.0.1:8686/pkg/abc.pkg',
      name: 'Jogo', contentId: 'UP0000-CUSA00001_00-0000000000000000', type: 'PS4GD', size: 1234, icon: Buffer.from('png')});
    const {ip, message} = await received;
    assert.equal(ip, '127.0.0.1');
    assert.deepEqual(message, {flag: 1, url: 'http://127.0.0.1:8686/pkg/abc.pkg', name: 'Jogo',
      contentId: 'UP0000-CUSA00001_00-0000000000000000', type: 'PS4GD', size: 1234n, iconLength: 3});
  } finally {
    dpi.close();
    fs.rmSync(file, {force: true});
  }
});

test('uninstallWithPayload sends the title and returns the system results', async () => {
  const file = path.join(os.tmpdir(), `uninstall-test-${process.pid}.bin`);
  fs.writeFileSync(file, Buffer.concat([Buffer.from('code'), Buffer.alloc(6, 0xb4)]));
  let request;
  // Fake BinLoader + payload: reads the request, answers init = 0, uninstall = 0x80990088.
  const loader = net.createServer(sock => {
    const chunks = [];
    sock.on('data', c => chunks.push(c));
    sock.on('end', () => {
      loader.close();
      const back = net.connect(Buffer.concat(chunks).readUInt16BE(8), '127.0.0.1');
      back.once('data', d => {
        request = {what: d.readUInt32LE(0), titleId: d.toString('ascii', 4, 13)};
        const reply = Buffer.alloc(8); reply.writeInt32LE(0, 0); reply.writeInt32LE(0x80990088 | 0, 4);
        back.end(reply);
      });
    });
  }).listen(0, '127.0.0.1');
  await new Promise(r => loader.once('listening', r));
  try {
    const r = await uninstallWithPayload({payloadPath: file, ps4Ip: '127.0.0.1', pcIp: '127.0.0.1',
      titleId: 'CUSA03587', what: 'patch', loaderPorts: [loader.address().port]});
    assert.deepEqual(request, {what: 2, titleId: 'CUSA03587'});
    assert.deepEqual(r, {init: 0, result: 0x80990088 | 0});
  } finally {
    fs.rmSync(file, {force: true});
  }
});
