// Updates from the GitHub releases (electron-updater). The Windows installer
// and the Linux AppImage and .deb download the new version in the background
// and install it on restart; the portable build cannot replace itself, so it
// only tells that a new version exists and opens its download page.
import fs from 'node:fs';
import path from 'node:path';
import {app, shell, type BrowserWindow} from 'electron';
import {autoUpdater} from 'electron-updater';
import type {AppCore} from '@core/AppCore';
import {AppError, toErrorInfo} from '@core/errors';
import type {UpdateStatus} from '@shared/types';

const RELEASES = 'https://github.com/lucasmaraia/PKGo/releases/latest';
/** Looks when the window gets focus (also at start) and every hour, at most every half hour. */
const CHECK_EVERY = 60 * 60 * 1000;
const STALE_AFTER = 30 * 60 * 1000;

/** The portable build runs from a temporary copy (set by electron-builder). */
const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
/** Release tests: look for updates, but never download or install them. */
const dryRun = !!process.env.PKGO_UPDATE_DRY_RUN;

/**
 * Installed for all users (Program Files): replacing it needs administrator
 * rights. Node cannot tell from permissions on Windows, so try writing there.
 */
function needsAdmin(): boolean {
  if (process.platform !== 'win32' || portable) return false;
  const probe = path.join(path.dirname(process.execPath), `.pkgo-write-test-${process.pid}`);
  try {
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, {force: true});
    return false;
  } catch {
    return true;
  }
}

export class Updater {
  private lastCheck = 0;
  private admin = false;

  constructor(private readonly core: AppCore) {}

  private set(status: UpdateStatus): void {
    this.core.setUpdate(status);
  }

  start(window: BrowserWindow): void {
    // Only an installed build knows where it came from (app-update.yml).
    if (!app.isPackaged) return this.set({state: 'off'});
    this.admin = needsAdmin();
    autoUpdater.autoDownload = !portable && !dryRun;
    // Installing on quit would show the administrator prompt out of nowhere
    // when the app is closed: then it installs only from the restart button.
    autoUpdater.autoInstallOnAppQuit = !portable && !this.admin && !dryRun;
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
        portable || dryRun
          ? {state: 'available', version: info.version, manual: portable}
          : {state: 'downloading', version: info.version, percent: 0},
      ),
    );
    autoUpdater.on('download-progress', p => {
      const current = this.core.update;
      this.set({state: 'downloading', version: current.version, percent: Math.floor(p.percent)});
    });
    autoUpdater.on('update-downloaded', info => this.set({state: 'ready', version: info.version, admin: this.admin}));
    autoUpdater.on('error', e => {
      // A failed background check is not worth an alert: the next one may work.
      this.set({state: 'error', error: toErrorInfo(new AppError('updateFailed', {detail: e.message}))});
    });
    this.set({state: 'idle'});
    setInterval(() => this.checkIfStale(), CHECK_EVERY);
    window.on('focus', () => this.checkIfStale());
    this.checkIfStale();
  }

  /** Automatic check: when turned on and not done in the last half hour. */
  private checkIfStale(): void {
    if (!this.core.config.get().autoUpdate || Date.now() - this.lastCheck < STALE_AFTER) return;
    void this.check().catch(() => {});
  }

  /** Looks for a new version now (also when automatic checks are off). */
  async check(): Promise<void> {
    if (!app.isPackaged) throw new AppError('updateUnavailable');
    const {state} = this.core.update;
    // Already found: nothing new to look for until it is installed.
    if (state === 'checking' || state === 'downloading' || state === 'ready') return;
    this.lastCheck = Date.now();
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
