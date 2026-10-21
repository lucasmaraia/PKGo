// Checks a packaged build (installer, portable, .deb, AppImage) end to end.
// The test writes a sample library and settings, starts the build with the
// command in PKGO_LAUNCH and drives it over the Chrome DevTools protocol, so
// it works the same for a Windows exe, a Linux container or WSL.
//
// Environment:
//   PKGO_LAUNCH     command that starts the build with --remote-debugging-port
//                   (it gets PKGO_USER_DATA, PKGO_TRASH_DIR and PKGO_UPDATE_DRY_RUN
//                   set; a container or WSL launcher passes them on itself)
//   PKGO_CDP        DevTools address, default http://127.0.0.1:9334
//   PKGO_HOST_DIR   working folder on this machine (created and emptied here)
//   PKGO_APP_DIR    the same folder as the app sees it (default PKGO_HOST_DIR)
//   PKGO_PS4        PS4 address for the read-only console checks (optional)
//   PKGO_STOP       command run at the end, e.g. to remove a container (optional)
//
// Nothing is installed on or deleted from the PS4.
import {execSync, spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {chromium, expect, test, type Browser, type Page} from '@playwright/test';
import {makePkg, makeSfo, PNG} from '../../tests/helpers/pkgFixtures';

const CDP = process.env.PKGO_CDP || 'http://127.0.0.1:9334';
const HOST = process.env.PKGO_HOST_DIR!;
const APP = process.env.PKGO_APP_DIR || HOST;
const PS4 = process.env.PKGO_PS4 || '';
/** Joins paths the way the app's system does (Windows or Linux). */
const appPath = (...parts: string[]) => (APP.includes('\\') ? path.win32 : path.posix).join(APP, ...parts);

test.describe.configure({mode: 'serial'});

let launcher: ChildProcess;
let browser: Browser;
let page: Page;

function writePkg(rel: string, sfo: Record<string, string | number>, contentId: string): void {
  const file = path.join(HOST, rel);
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

const state = () => page.evaluate(() => window.api.getState());

test.beforeAll(async () => {
  test.setTimeout(240_000);
  fs.rmSync(HOST, {recursive: true, force: true});
  fs.mkdirSync(path.join(HOST, 'data'), {recursive: true});
  fs.mkdirSync(path.join(HOST, 'trash'));
  writePkg(
    'library/Alpha.pkg',
    {TITLE: 'Alpha Game', TITLE_ID: 'CUSA00001', CATEGORY: 'gd', APP_VER: '01.00'},
    'UP0000-CUSA00001_00-ALPHA00000000000',
  );
  writePkg(
    'library/Alpha Update/Alpha-Update.pkg',
    {TITLE: 'Alpha Game', TITLE_ID: 'CUSA00001', CATEGORY: 'gp', APP_VER: '01.05'},
    'UP0000-CUSA00001_00-ALPHA00000000000',
  );
  writePkg(
    'library/Homebrew.pkg',
    {TITLE: 'Beta Homebrew', TITLE_ID: 'LAPY10010', CATEGORY: 'gd', APP_VER: '01.00'},
    'IV0000-LAPY10010_00-BETA000000000000',
  );
  writePkg(
    'extra/Gamma/Gamma.pkg',
    {TITLE: 'Gamma DLC', TITLE_ID: 'CUSA00001', CATEGORY: 'ac', APP_VER: '01.00'},
    'UP0000-CUSA00001_00-GAMMADLC00000000',
  );
  fs.writeFileSync(
    path.join(HOST, 'data', 'config.json'),
    JSON.stringify({
      ps4Ip: PS4 || '127.0.0.1',
      language: 'en',
      autoUpdate: false,
      folders: [{path: appPath('library'), recursive: true}],
    }),
  );
  launcher = spawn(process.env.PKGO_LAUNCH!, {
    shell: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PKGO_USER_DATA: appPath('data'),
      PKGO_TRASH_DIR: appPath('trash'),
      // Find updates, but never download or install one during the test.
      PKGO_UPDATE_DRY_RUN: '1',
    },
  });
  for (let i = 0; ; i++) {
    try {
      browser = await chromium.connectOverCDP(CDP);
      break;
    } catch (e) {
      if (i > 150) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  // The app's window (its page is index.html; DevTools may list others).
  for (let i = 0; i < 60; i++) {
    const found = browser
      .contexts()[0]
      ?.pages()
      .find(p => p.url().includes('index.html'));
    if (found) {
      page = found;
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }
  await expect(page.locator('#grid .card')).toHaveCount(3, {timeout: 60_000});
});

test.afterAll(async () => {
  // Closing the browser over DevTools quits the app.
  await browser?.close().catch(() => {});
  launcher?.kill();
  if (process.env.PKGO_STOP) execSync(process.env.PKGO_STOP, {stdio: 'ignore'});
});

test('starts with its window and version', async () => {
  await expect(page).toHaveTitle('PKGo');
  const version = await page.evaluate(() => window.api.version);
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  if (process.env.PKGO_EXPECT_VERSION) expect(version).toBe(process.env.PKGO_EXPECT_VERSION);
  console.log(`version ${version}`);
});

test('reaches the PS4 and reads its games (read-only)', async () => {
  test.skip(!PS4, 'no PS4 address given');
  await expect.poll(async () => (await state()).ps4, {timeout: 30_000}).toBe('ready');
  await expect.poll(async () => (await state()).console.state, {timeout: 120_000}).toBe('ready');
  const s = await state();
  expect(s.console.items.length).toBeGreaterThan(0);
  console.log(`console: ${s.console.items.length} titles, log ${s.klog}, PC address ${s.lanIp}`);
});

test('lists the console games, with their region', async () => {
  test.skip(!PS4, 'no PS4 address given');
  await page.locator('.tab[data-view="ps4"]').click();
  const count = (await state()).console.items.length;
  await expect(page.locator('#consoleGrid .card')).toHaveCount(count);
  const game = (await state()).console.items.find(c => c.kind === 'game' && c.region)!;
  await page.locator(`#consoleGrid .card[data-title="${game.titleId}"]`).click();
  await expect(page.locator('#details')).toContainText('Region');
  await page.keyboard.press('Escape');
  await expect(page.locator('#details')).toBeHidden();
  await page.locator('.tab[data-view="pc"]').click();
});

test('library: kinds, filters and search', async () => {
  const cards = page.locator('#grid .card');
  await page.locator('.chip[data-kind="app"]').click();
  await expect(cards.locator('h3')).toHaveText(['Beta Homebrew']);
  await page.locator('.chip[data-kind="patch"]').click();
  await expect(cards.first().locator('.meta').first()).toContainText('v01.05');
  await page.locator('.chip[data-kind="all"]').click();
  await page.locator('#search').fill('cusa00001');
  await expect(cards).toHaveCount(2);
  await page.locator('#search').fill('');
  await expect(cards).toHaveCount(3);
});

test('details panel opens and closes with a click outside', async () => {
  await page.locator('#grid .card', {hasText: 'Beta Homebrew'}).click();
  const panel = page.locator('#details');
  await expect(panel).toContainText('LAPY10010');
  await page.mouse.click(20, 300);
  await expect(panel).toBeHidden();
});

test('arrow keys move between tiles and Enter opens one', async () => {
  const cards = page.locator('#grid .card');
  await cards.first().focus();
  await page.keyboard.press('ArrowRight');
  await expect(cards.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#details')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('switches language right away', async () => {
  await page.locator('[data-action="openSettings"].tab').click();
  await page.locator('#languageSelect').selectOption('pt-BR');
  await expect(page.locator('#viewTitle')).toHaveText('No PC');
  await page.locator('#languageSelect').selectOption('es');
  await expect(page.locator('#viewTitle')).toHaveText('En el PC');
  await page.locator('#languageSelect').selectOption('en');
  await expect(page.locator('#viewTitle')).toHaveText('On PC');
  await page.keyboard.press('Escape');
});

test('selection mode and check all', async () => {
  const cards = page.locator('#grid .card');
  await expect(cards.first().locator('.pick')).toBeHidden();
  await page.locator('#selectMode').check();
  await cards.first().click();
  await expect(page.locator('#details')).toBeHidden();
  await expect(page.locator('#selectedCount')).toHaveText('1 checked');
  await page.locator('#selectAll').check();
  await expect(page.locator('#selectedCount')).toHaveText('3 checked');
  await page.locator('#selectMode').uncheck();
  await expect(page.locator('#selectedCount')).toHaveText('');
});

test('shows the drop area while files are dragged over', async () => {
  const drag = (type: string) =>
    page.evaluate(t => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], 'game.pkg'));
      document.body.dispatchEvent(new DragEvent(t, {dataTransfer: data, bubbles: true}));
    }, type);
  await drag('dragenter');
  await expect(page.locator('#dropOverlay')).toBeVisible();
  await drag('dragleave');
  await expect(page.locator('#dropOverlay')).toBeHidden();
});

test('adds dropped folders', async () => {
  const added = await page.evaluate(folder => window.api.addPaths([folder]), appPath('extra'));
  expect(added).toEqual({folders: 1, files: 0});
  await expect(page.locator('#grid .card')).toHaveCount(4);
});

test('looks for updates', async () => {
  await page.evaluate(() => window.api.checkUpdates());
  await expect.poll(async () => (await state()).update.state, {timeout: 60_000}).toMatch(/^(idle|available)$/);
  const u = (await state()).update;
  console.log(`update: ${u.state} ${u.version ?? ''}`);
});

test('deletes checked packages to the trash, with their own folder', async () => {
  await page.locator('#selectMode').check();
  await page.locator('#grid .card', {hasText: 'Gamma DLC'}).click();
  await page.locator('#grid .card', {hasText: 'Beta Homebrew'}).click();
  await page.locator('[data-action="deleteSelected"]').click();
  await expect(page.locator('#deleteSummary')).toContainText('1 file(s) and 1 folder(s)');
  await page.locator('#confirmDelete').click();
  await expect(page.locator('#grid .card')).toHaveCount(2);
  expect(fs.readdirSync(path.join(HOST, 'trash')).sort()).toEqual(['Gamma', 'Homebrew.pkg']);
  await page.locator('#selectMode').uncheck();
});

test('copies a diagnostic report', async () => {
  await page.locator('[data-action="openSettings"].tab').click();
  await page.locator('[data-action="copyDiagnostics"]').click();
  await expect(page.locator('.toast.success').last()).toContainText('Diagnostics copied');
  await page.keyboard.press('Escape');
});
