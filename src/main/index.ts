// Electron main process: one window, the core services and the IPC bridge.
import fs from 'node:fs';
import path from 'node:path';
import {app, BrowserWindow, dialog, Menu, nativeImage, Notification, shell, Tray} from 'electron';
import {AppCore} from '@core/AppCore';
import {matchLanguage, translate, translateError} from '@shared/i18n';
import {registerIpc} from './ipc';
import {registerMediaProtocol, registerMediaScheme} from './media';

const ICON = path.join(__dirname, '../../resources/icon.png');

let core: AppCore;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stopped = false;

const t = (key: string, params?: Record<string, string | number>) => translate(core.language, key, params);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#01113d',
    title: 'PKGo',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--app-version=${app.getVersion()}`],
    },
  });
  win.once('ready-to-show', () => win.show());

  // Links open in the browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({url}) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return {action: 'deny'};
  });
  win.webContents.on('will-navigate', event => event.preventDefault());

  // Closing during a download would cut it: offer to keep going in the tray.
  win.on('close', event => {
    if (quitting || !core.busy) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'PKGo',
      message: t('close.busyTitle'),
      detail: t('close.busyDetail'),
      buttons: [t('close.background'), t('close.quit'), t('common.cancel')],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 0) runInBackground(win);
    else if (choice === 1) {
      quitting = true;
      app.quit();
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
  return win;
}

/**
 * Up to version 2.1 the app was called PKG Sender and kept its settings in
 * that folder: bring them over on the first start under the new name.
 */
function migrateFromPkgSender(configFile: string): void {
  if (process.env.PKGO_USER_DATA || fs.existsSync(configFile)) return;
  const old = path.join(app.getPath('appData'), 'PKG Sender', 'config.json');
  try {
    if (!fs.existsSync(old)) return;
    fs.mkdirSync(path.dirname(configFile), {recursive: true});
    fs.copyFileSync(old, configFile);
  } catch {
    // Unreadable: start with default settings.
  }
}

function showWindow(): void {
  if (!window) return;
  window.show();
  if (window.isMinimized()) window.restore();
  window.focus();
  tray?.destroy();
  tray = null;
}

function runInBackground(win: BrowserWindow): void {
  win.hide();
  tray = new Tray(nativeImage.createFromPath(ICON).resize({width: 16, height: 16}));
  tray.setToolTip(t('tray.tooltip'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {label: t('tray.open'), click: showWindow},
      {
        label: t('tray.quit'),
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showWindow);
}

// Separate data folder, e.g. for the end-to-end tests.
if (process.env.PKGO_USER_DATA) app.setPath('userData', process.env.PKGO_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerMediaScheme();
  Menu.setApplicationMenu(null);

  app.on('second-instance', showWindow);

  void app.whenReady().then(async () => {
    const configFile = path.join(app.getPath('userData'), 'config.json');
    migrateFromPkgSender(configFile);
    core = new AppCore({
      configFile,
      payloadDir: app.isPackaged
        ? path.join(process.resourcesPath, 'payloads')
        : path.join(app.getAppPath(), 'resources', 'payloads'),
      systemLanguage: matchLanguage(app.getPreferredSystemLanguages()[0] || app.getLocale()),
    });
    registerMediaProtocol(core);
    registerIpc(core, () => window);
    try {
      await core.start();
    } catch (e) {
      dialog.showErrorBox('PKGo', t('errors.startFailed', {detail: (e as Error).message}));
      app.exit(1);
      return;
    }
    // Running in the tray only for a download: say how it went, then leave.
    core.on('change', () => {
      if (!tray || core.busy || !window || window.isVisible()) return;
      const last = [...core.queue.jobs].sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
      if (last && Notification.isSupported()) {
        const body =
          last.state === 'done'
            ? t('jobs.doneToast', {title: last.title})
            : `${last.title}: ${last.error ? translateError(core.language, last.error) : ''}`;
        new Notification({title: 'PKGo', body, icon: ICON}).show();
      }
      quitting = true;
      app.quit();
    });
    window = createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  // Release the payload waiting on the PS4 and the PKG server before leaving.
  app.on('before-quit', event => {
    quitting = true;
    if (stopped || !core) return;
    event.preventDefault();
    stopped = true;
    void core.stop().finally(() => app.quit());
  });
}
