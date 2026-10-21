import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {_electron as electron, expect, test, type ElectronApplication, type Page} from '@playwright/test';
import {makePkg, makeSfo, PNG} from '../tests/helpers/pkgFixtures';

const ROOT = path.resolve(__dirname, '..');

let app: ElectronApplication;
let page: Page;
let dataDir: string;
let library: string;

function writePkg(file: string, sfo: Record<string, string | number>, contentId: string): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(
    file,
    makePkg(
      [
        {id: 0x1000, data: makeSfo(sfo)},
        {id: 0x1200, data: PNG},
      ],
      contentId,
    ),
  );
}

test.beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgo-e2e-'));
  library = path.join(dataDir, 'library');
  writePkg(
    path.join(library, 'Alpha.pkg'),
    {TITLE: 'Alpha Game', TITLE_ID: 'CUSA00001', CATEGORY: 'gd', APP_VER: '01.00'},
    'UP0000-CUSA00001_00-ALPHA00000000000',
  );
  writePkg(
    path.join(library, 'updates', 'Alpha-Update.pkg'),
    {TITLE: 'Alpha Game', TITLE_ID: 'CUSA00001', CATEGORY: 'gp', APP_VER: '01.05'},
    'UP0000-CUSA00001_00-ALPHA00000000000',
  );
  writePkg(
    path.join(library, 'Homebrew.pkg'),
    {TITLE: 'Beta Homebrew', TITLE_ID: 'LAPY10010', CATEGORY: 'gd', APP_VER: '01.00'},
    'IV0000-LAPY10010_00-BETA000000000000',
  );
  // A PS4 address where nothing answers: the app runs offline.
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ps4Ip: '127.0.0.1', language: 'en', folders: [{path: library, recursive: true}]}),
  );
  app = await electron.launch({
    args: [ROOT, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: {...process.env, PKGO_USER_DATA: dataDir},
  });
  page = await app.firstWindow();
  await expect(page.locator('#grid .card')).toHaveCount(3);
});

test.afterEach(async () => {
  await app.close();
  fs.rmSync(dataDir, {recursive: true, force: true});
});

test('lists the library with kinds, filters and search', async () => {
  await expect(page.locator('#viewTitle')).toHaveText('On PC');
  await expect(page.locator('#ps4Status')).toContainText('127.0.0.1');
  // Homebrew with a game category is an app, not a game.
  await page.locator('.chip[data-kind="app"]').click();
  await expect(page.locator('#grid .card h3')).toHaveText(['Beta Homebrew']);
  await page.locator('.chip[data-kind="patch"]').click();
  await expect(page.locator('#grid .card .meta').first()).toContainText('v01.05');
  await page.locator('.chip[data-kind="all"]').click();
  await page.locator('#search').fill('cusa00001');
  await expect(page.locator('#grid .card')).toHaveCount(2);
});

test('opens the options panel and closes it with a click outside', async () => {
  await page.locator('#grid .card', {hasText: 'Beta Homebrew'}).click();
  const panel = page.locator('#details');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('LAPY10010');
  // Inside: stays open.
  await panel.locator('h2').click();
  await expect(panel).toBeVisible();
  // On the backdrop, left of the side panel: closes.
  await page.mouse.click(20, 300);
  await expect(panel).toBeHidden();
});

test('moves between tiles with the arrow keys and opens with Enter', async () => {
  await page.locator('#grid .card').first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#grid .card').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#grid .card').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#details')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#details')).toBeHidden();
});

test('switches language right away', async () => {
  await page.locator('[data-action="openSettings"].tab').click();
  await page.locator('#languageSelect').selectOption('pt-BR');
  await expect(page.locator('#viewTitle')).toHaveText('No PC');
  await page.locator('#languageSelect').selectOption('es');
  await expect(page.locator('#viewTitle')).toHaveText('En el PC');
});

test('copies a diagnostic report without personal paths', async () => {
  await page.locator('[data-action="openSettings"].tab').click();
  await page.locator('[data-action="copyDiagnostics"]').click();
  await expect(page.locator('.toast.success')).toBeVisible();
  const report = await app.evaluate(({clipboard}) => clipboard.readText());
  expect(report).toContain('PKGo diagnostics');
  expect(report).toContain('packages: 3');
  expect(report).not.toContain(os.homedir());
});

test('shows the drop area while files are dragged over the window', async () => {
  const overlay = page.locator('#dropOverlay');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'game.pkg'));
    document.body.dispatchEvent(new DragEvent('dragenter', {dataTransfer: data, bubbles: true}));
  });
  await expect(overlay).toBeVisible();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'game.pkg'));
    document.body.dispatchEvent(new DragEvent('dragleave', {dataTransfer: data, bubbles: true}));
  });
  await expect(overlay).toBeHidden();
});

test('adds dropped folders and PKG files', async () => {
  const extra = path.join(dataDir, 'extra');
  writePkg(
    path.join(extra, 'Gamma.pkg'),
    {TITLE: 'Gamma DLC', TITLE_ID: 'CUSA00001', CATEGORY: 'ac', APP_VER: '01.00'},
    'UP0000-CUSA00001_00-GAMMADLC00000000',
  );
  const added = await page.evaluate(folder => window.api.addPaths([folder, 'not-a-path']), extra);
  expect(added).toEqual({folders: 1, files: 0});
  await expect(page.locator('#grid .card')).toHaveCount(4);
  await expect(page.evaluate(() => window.api.addPaths(['nothing-here']))).rejects.toThrow();
});

test('checks tiles and queues them, games before updates', async () => {
  const cards = page.locator('#grid .card');
  // The checkbox checks the tile without opening it.
  await cards.first().locator('.pick').click();
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.locator('#selectedCount')).toHaveText('1 checked');
  await expect(cards.first()).toHaveClass(/selected/);
  // Space on a focused tile checks it too.
  await cards.nth(1).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#selectedCount')).toHaveText('2 checked');
  // Check all follows the filter: only the app is visible here.
  await page.locator('.chip[data-kind="app"]').click();
  await page.locator('#selectAll').uncheck();
  await page.locator('.chip[data-kind="all"]').click();
  await page.locator('#selectAll').check();
  await expect(page.locator('#selectedCount')).toHaveText('3 checked');
  await page.locator('[data-action="installSelected"]').click();
  await expect(page.locator('#selectedCount')).toHaveText('');
  const order = await page.evaluate(async () => {
    const s = await window.api.getState();
    return s.jobs.map(j => s.library.find(i => i.id === j.pkgId)!.kind);
  });
  expect(order).toHaveLength(3);
  expect(order[2]).toBe('patch');
});
