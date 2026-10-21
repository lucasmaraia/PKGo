// Renders the app icon from build/icon.svg (and build/icon-small.svg for
// 16-32 px) to resources/icon.png and build/icon.ico. Run: npm run icons
//
// Transparent windows do not load on every system, so each SVG is drawn on
// black and on white, and the transparency comes from the difference.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {app, BrowserWindow, nativeImage} from 'electron';

const ROOT = path.resolve(import.meta.dirname, '..');
const RENDER = 1024;
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SMALL = 32;

app.commandLine.appendSwitch('force-device-scale-factor', '1');

/** BGRA pixels of an SVG file drawn on a background color. */
async function draw(win, file, background) {
  const page = path.join(os.tmpdir(), `pkgo-icon-${process.pid}.html`);
  fs.writeFileSync(
    page,
    `<html style="overflow:hidden"><body style="margin:0;overflow:hidden;background:${background}"><img src="${pathToFileURL(path.join(ROOT, file))}"` +
      ` width="${RENDER}" height="${RENDER}" style="display:block"></body></html>`,
  );
  try {
    await win.loadFile(page);
    await new Promise(r => setTimeout(r, 300));
    const image = await win.webContents.capturePage({x: 0, y: 0, width: RENDER, height: RENDER});
    return image.resize({width: RENDER, height: RENDER}).toBitmap();
  } finally {
    fs.rmSync(page, {force: true});
  }
}

/** The SVG with its transparency, as a nativeImage. */
async function render(win, file) {
  const black = await draw(win, file, '#000');
  const white = await draw(win, file, '#fff');
  const out = Buffer.alloc(black.length);
  for (let i = 0; i < black.length; i += 4) {
    // On black a pixel shows c·a, on white c·a + (1 - a).
    const alpha = 255 - Math.max(0, Math.min(255, white[i + 1] - black[i + 1]));
    for (let c = 0; c < 3; c++) out[i + c] = alpha ? Math.min(255, Math.round((black[i + c] * 255) / alpha)) : 0;
    out[i + 3] = alpha;
  }
  return nativeImage.createFromBitmap(out, {width: RENDER, height: RENDER});
}

/** An .ico holding one PNG per size (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({size, data}) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({width: RENDER, height: RENDER, useContentSize: true, show: false});
  try {
    const big = await render(win, 'build/icon.svg');
    const small = await render(win, 'build/icon-small.svg');
    const at = size => (size <= SMALL ? small : big).resize({width: size, height: size, quality: 'best'}).toPNG();
    fs.writeFileSync(path.join(ROOT, 'resources/icon.png'), at(512));
    fs.writeFileSync(path.join(ROOT, 'build/icon.ico'), ico(ICO_SIZES.map(size => ({size, data: at(size)}))));
    console.log(`Wrote resources/icon.png (512 px) and build/icon.ico (${ICO_SIZES.join(', ')} px)`);
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
