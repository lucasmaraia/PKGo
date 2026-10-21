// Updates from the GitHub releases (electron-updater). The Windows installer
// and the Linux AppImage and .deb download the new version in the background
// and install it on restart; the portable build cannot replace itself, so it
// only tells that a new version exists and opens its download page.
import {app, shell} from 'electron';
import {autoUpdater} from 'electron-updater';
import type {AppCore} from '@core/AppCore';
import {AppError, toErrorInfo} from '@core/errors';
import type {UpdateStatus} from '@shared/types';

const RELEASES = 'https://github.com/lucasmaraia/PKGo/releases/latest';
/** First check a little after start (not to slow it down), then every few hours. */
const FIRST_CHECK = 15_000;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

/** The portable build runs from a temporary copy (set by electron-builder). */
const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;

export class Updater {
  constructor(private readonly core: AppCore) {}

  private set(status: UpdateStatus): void {
    this.core.setUpdate(status);
  }

  start(): void {
    // Only an installed build knows where it came from (app-update.yml).
    if (!app.isPackaged) return this.set({state: 'off'});
    autoUpdater.autoDownload = !portable;
    autoUpdater.autoInstallOnAppQuit = !portable;
    autoUpdater.logger = {
      info: (m: unknown) => this.core.log.add(`update: ${String(m)}`),
      warn: (m: unknown) => this.core.log.add(`update warning: ${String(m)}`),
      error: (m: unknown) => this.core.log.add(`update error: ${String(m)}`),
      debug: () => {},
    };
    autoUpdater.on('checking-for-update', () => this.set({state: 'checking'}));
    autoUpdater.on('update-not-available', () => this.set({state: 'idle', checkedAt: Date.now()}));
    autoUpdater.on('update-available', info =>
      this.set(
        portable
          ? {state: 'available', version: info.version, manual: true}
          : {state: 'downloading', version: info.version, percent: 0},
      ),
    );
    autoUpdater.on('download-progress', p => {
      const current = this.core.update;
      this.set({state: 'downloading', version: current.version, percent: Math.floor(p.percent)});
    });
    autoUpdater.on('update-downloaded', info => this.set({state: 'ready', version: info.version}));
    autoUpdater.on('error', e => {
      // A failed background check is not worth an alert: the next one may work.
      this.set({state: 'error', error: toErrorInfo(new AppError('updateFailed', {detail: e.message}))});
    });
    this.set({state: 'idle'});
    setTimeout(() => {
      setInterval(() => this.checkIfEnabled(), CHECK_EVERY);
      this.checkIfEnabled();
    }, FIRST_CHECK);
  }

  private checkIfEnabled(): void {
    if (this.core.config.get().autoUpdate) void this.check().catch(() => {});
  }

  /** Looks for a new version now (also when automatic checks are off). */
  async check(): Promise<void> {
    if (!app.isPackaged) throw new AppError('updateUnavailable');
    const {state} = this.core.update;
    // Already found: nothing new to look for until it is installed.
    if (state === 'checking' || state === 'downloading' || state === 'ready') return;
    await autoUpdater.checkForUpdates();
  }

  /** Restarts into the downloaded version, or opens the download page (portable). */
  install(): void {
    const update = this.core.update;
    if (update.state === 'available' && update.manual) {
      void shell.openExternal(RELEASES);
      return;
    }
    if (update.state !== 'ready') throw new AppError('updateNotReady');
    // Restarting now would cut the download to the PS4.
    if (this.core.busy) throw new AppError('updateWaitForJobs');
    autoUpdater.quitAndInstall();
  }
}
