// Electron main process: one window, the core services and the IPC bridge.
import path from 'node:path';
import {app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray} from 'electron';
import {AppCore} from '@core/AppCore';
import {matchLanguage, translate} from '@shared/i18n';
import {registerIpc} from './ipc';
import {registerMediaProtocol, registerMediaScheme} from './media';

const ICON = path.join(__dirname, '../../resources/icon.png');

let core: AppCore;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const t = (key: string, params?: Record<string, string | number>) => translate(core.language, key, params);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#01113d',
    title: 'PKG Sender',
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
      title: 'PKG Sender',
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerMediaScheme();
  Menu.setApplicationMenu(null);

  app.on('second-instance', showWindow);

  void app.whenReady().then(async () => {
    core = new AppCore({
      configFile: path.join(app.getPath('userData'), 'config.json'),
      // 1.x kept config.json next to server.mjs; import it when running from source.
      legacyConfigFile: app.isPackaged ? undefined : path.join(app.getAppPath(), 'config.json'),
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
      dialog.showErrorBox('PKG Sender', t('errors.startFailed', {detail: (e as Error).message}));
      app.exit(1);
      return;
    }
    // Running in the tray only for a download: leave once it is over.
    core.on('change', () => {
      if (tray && !core.busy && window && !window.isVisible()) {
        quitting = true;
        app.quit();
      }
    });
    window = createWindow();
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    void core?.stop();
  });
}
