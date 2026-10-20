// Ties the services together: what the interface shows (state) and the
// actions it can take. Independent of Electron, so it can run headless too.
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppState,
  ConfigPatch,
  DiscoveredConsole,
  Language,
  LibraryItem,
  Ps4Status,
  UninstallTarget,
} from '@shared/types';
import {ConfigStore} from './config/ConfigStore';
import {ConsoleService, type RawConsoleItem} from './console/ConsoleService';
import {probeFtp} from './console/FtpClient';
import {KlogMonitor, type KlogEvent} from './console/KlogMonitor';
import {AppError, hex} from './errors';
import {InstallQueue} from './install/InstallQueue';
import {LibraryService, pkgId, type LibraryEntry} from './library/LibraryService';
import {discoverConsoles} from './network/discovery';
import {lanIp} from './network/lan';
import {InstallPayload, uninstallWithPayload} from './payload/PayloadClient';
import {titleFor} from './pkg/PkgReader';
import {PkgFileServer} from './server/PkgFileServer';

export interface AppCoreOptions {
  configFile: string;
  /** Folder with install.bin and uninstall.bin. */
  payloadDir: string;
  systemLanguage: Language;
}

const STATUS_INTERVAL = 5000;

/** The PS4 keeps each DLC in a folder named after the end of its content ID (UP0000-CUSA00000_00-<label>). */
export const dlcLabel = (contentId: string | null | undefined): string | null =>
  /^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-([A-Z0-9]{16})$/.exec(contentId || '')?.[1] ?? null;
/** Seconds between console re-reads after a download (about five minutes in total). */
const WATCH_DELAYS = [5, 10, 15, 20, 30, 30, 60, 60, 90];

export class AppCore extends EventEmitter<{change: []}> {
  readonly config: ConfigStore;
  readonly library: LibraryService;
  readonly console: ConsoleService;
  readonly server: PkgFileServer;
  readonly queue: InstallQueue;
  private readonly klog: KlogMonitor;
  private consoleRefreshTimer: NodeJS.Timeout | null = null;
  private readonly installPayload: InstallPayload;
  private readonly uninstallPayload: string;
  private ps4: Ps4Status = 'checking';
  private statusTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AppCoreOptions) {
    super();
    const changed = () => this.emit('change');
    this.config = new ConfigStore(options.configFile);
    this.library = new LibraryService(() => this.config.get(), changed);
    this.console = new ConsoleService(
      () => ({host: this.config.get().ps4Ip, port: this.config.get().ftpPort}),
      changed,
    );
    this.server = new PkgFileServer(id => this.library.get(id));
    this.installPayload = new InstallPayload(path.join(options.payloadDir, 'install.bin'));
    this.uninstallPayload = path.join(options.payloadDir, 'uninstall.bin');
    this.queue = new InstallQueue({
      library: id => this.library.get(id),
      title: entry => this.title(entry),
      payload: this.installPayload,
      files: this.server,
      network: () => {
        const {ps4Ip} = this.config.get();
        return {ps4Ip, pcIp: lanIp(ps4Ip), port: this.server.port};
      },
      onChange: changed,
      onDownloaded: entry => void this.watchInstall(entry),
    });
    this.klog = new KlogMonitor(() => this.config.get().ps4Ip);
    this.klog.on('event', event => this.onKlog(event));
  }

  /** Reacts to what the PS4 log reports about downloads, installs and deletions. */
  private onKlog(event: KlogEvent): void {
    switch (event.type) {
      case 'ourTask':
        return this.queue.attachTask(event.task);
      case 'taskEnded':
        return this.queue.taskEnded(event.task, event.error);
      case 'taskDeleted':
        return this.queue.taskDeleted(event.task);
      case 'installEnded':
        this.queue.installEnded(event.task, event.result);
        return this.refreshConsoleSoon();
      case 'gameDeleted':
        // Deleted on the PS4 (by its menu or by us): show it without waiting.
        return this.refreshConsoleSoon();
    }
  }

  /** Re-reads the console list shortly; several events in a row cause one read. */
  private refreshConsoleSoon(delay = 3000): void {
    if (this.consoleRefreshTimer) clearTimeout(this.consoleRefreshTimer);
    this.consoleRefreshTimer = setTimeout(() => void this.console.refresh(), delay);
  }

  get language(): Language {
    return this.config.get().language || this.options.systemLanguage;
  }

  /** A download is running or waiting: closing now would cut it. */
  get busy(): boolean {
    return this.queue.busy;
  }

  async start(): Promise<void> {
    await this.server.listen(this.config.get().serverPort);
    void this.checkPs4();
    this.statusTimer = setInterval(() => void this.checkPs4(), STATUS_INTERVAL);
    void this.library.rescan();
    void this.console.refresh();
    this.klog.start();
  }

  async stop(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.consoleRefreshTimer) clearTimeout(this.consoleRefreshTimer);
    this.klog.stop();
    await this.installPayload.close();
    await this.server.close();
  }

  private async checkPs4(): Promise<void> {
    const {ps4Ip, ftpPort} = this.config.get();
    const next: Ps4Status = !ps4Ip ? 'unconfigured' : (await probeFtp(ps4Ip, ftpPort)) ? 'ready' : 'offline';
    if (next !== this.ps4) {
      const cameOnline = next === 'ready' && this.ps4 !== 'checking';
      this.ps4 = next;
      this.emit('change');
      // The console was off or rebooted: its game list may have changed.
      if (cameOnline) void this.console.refresh();
    }
  }

  /**
   * After the download the PS4 still installs the package, which takes from
   * seconds to minutes. Re-read the console list until it shows the package
   * (or give up after about five minutes), so both tabs catch up by themselves.
   */
  private async watchInstall(entry: LibraryEntry): Promise<void> {
    const {titleId, kind, version} = entry.info;
    if (!titleId) return;
    const label = dlcLabel(entry.info.contentId);
    const installed = () => {
      const c = this.console.find(titleId);
      if (!c) return false;
      if (kind === 'patch') return !!version && (c.patchVersion || '') >= version;
      if (kind === 'dlc') return !!label && c.dlcs.includes(label);
      return true;
    };
    for (const seconds of WATCH_DELAYS) {
      await new Promise(r => setTimeout(r, seconds * 1000));
      await this.console.settled();
      if ((await this.console.refresh()) && installed()) return;
    }
  }

  private title(entry: LibraryEntry): string {
    return entry.info.titles ? titleFor(entry.info.titles, this.language) : entry.name;
  }

  /** Compares a PC package with the console list. null = unknown (not loaded, or DLC). */
  private installState(entry: LibraryEntry): Pick<LibraryItem, 'installed' | 'installedVersion' | 'newer'> {
    const {info} = entry;
    const unknown = {installed: null, installedVersion: null, newer: false};
    if (this.console.state(this.language).state !== 'ready' || !info.titleId) return unknown;
    const c: RawConsoleItem | undefined = this.console.find(info.titleId);
    if (info.kind === 'dlc') {
      const label = dlcLabel(info.contentId);
      if (!label) return unknown;
      return {installed: !!c?.dlcs.includes(label), installedVersion: null, newer: false};
    }
    if (info.kind === 'patch') {
      if (!c) return {installed: false, installedVersion: null, newer: false};
      const current = c.patchVersion || c.baseVersion || '';
      const version = info.version || '';
      return {
        installed: !!version && current >= version,
        installedVersion: current,
        newer: !!version && version > current,
      };
    }
    return {installed: !!c, installedVersion: c?.version || null, newer: false};
  }

  private publicItem(entry: LibraryEntry, all: LibraryEntry[]): LibraryItem {
    const {info} = entry;
    // Update PKGs usually have no icon; borrow the game's from the PC library.
    const iconFrom = info.icon ? entry : all.find(o => o.info.icon && o.info.titleId === info.titleId);
    return {
      id: entry.id,
      name: entry.name,
      path: entry.path,
      size: entry.size,
      error: entry.error,
      title: this.title(entry),
      titleId: info.titleId || null,
      contentId: info.contentId || null,
      version: info.version || null,
      kind: info.kind || 'other',
      category: info.category || null,
      firmware: info.firmware || null,
      hasIcon: !!iconFrom,
      iconId: iconFrom?.id || null,
      hasPic: !!info.pic,
      ...this.installState(entry),
    };
  }

  getState(): AppState {
    const config = this.config.get();
    const entries = this.library.items;
    const language = this.language;
    return {
      config: {ps4Ip: config.ps4Ip, ftpPort: config.ftpPort, language: config.language, folders: config.folders},
      language,
      lanIp: lanIp(config.ps4Ip),
      ps4: this.ps4,
      scan: {...this.library.scan, missing: [...this.library.scan.missing]},
      library: entries
        .map(e => this.publicItem(e, entries))
        .sort((a, b) => a.title.localeCompare(b.title, language) || (b.version || '').localeCompare(a.version || '')),
      console: this.console.state(language),
      jobs: this.queue.jobs.map(j => ({...j})),
      payloads: {install: this.installPayload.available, uninstall: fs.existsSync(this.uninstallPayload)},
    };
  }

  // ---------- settings ----------

  setConfig(patch: ConfigPatch): void {
    const before = this.config.get();
    const after = this.config.update(patch);
    if (after.ps4Ip !== before.ps4Ip || after.ftpPort !== before.ftpPort) {
      this.ps4 = 'checking';
      this.console.reset();
      this.klog.restart();
      void this.checkPs4();
      void this.console.refresh();
    }
    this.emit('change');
  }

  discover(): Promise<DiscoveredConsole[]> {
    return discoverConsoles(this.config.get().ftpPort);
  }

  // ---------- library ----------

  async addFolders(paths: string[]): Promise<number> {
    const folders = [...this.config.get().folders];
    const added = paths.filter(p => !folders.some(f => path.resolve(f.path) === path.resolve(p)));
    if (!added.length) return 0;
    this.config.update({folders: [...folders, ...added.map(p => ({path: p, recursive: true}))]});
    await this.library.rescan();
    return added.length;
  }

  async removeFolder(folder: string): Promise<void> {
    this.config.update({folders: this.config.get().folders.filter(f => f.path !== folder)});
    await this.library.rescan();
  }

  async setFolderRecursive(folder: string, recursive: boolean): Promise<void> {
    this.config.update({folders: this.config.get().folders.map(f => (f.path === folder ? {...f, recursive} : f))});
    await this.library.rescan();
  }

  async addFiles(paths: string[]): Promise<number> {
    const {files, hidden} = this.config.get();
    const ids = new Set(paths.map(pkgId));
    this.config.update({
      files: [...new Set([...files, ...paths])],
      hidden: hidden.filter(id => !ids.has(id)),
    });
    await this.library.rescan();
    return paths.length;
  }

  rescan(): Promise<void> {
    return this.library.rescan();
  }

  /** Hides a PKG from the library; the file stays on disk. */
  removeFromLibrary(id: string): void {
    const entry = this.library.get(id);
    if (!entry) return;
    const {files, hidden} = this.config.get();
    this.config.update({
      files: files.filter(f => path.resolve(f) !== entry.path),
      hidden: hidden.includes(id) ? hidden : [...hidden, id],
    });
    this.library.delete(id);
  }

  icon(id: string): Buffer | null {
    return this.library.get(id)?.info.icon || null;
  }

  pic(id: string): Buffer | null {
    return this.library.get(id)?.info.pic || null;
  }

  consoleIcon(titleId: string): Buffer | null {
    return this.console.icons.get(titleId) || null;
  }

  // ---------- console ----------

  install(id: string): void {
    this.queue.enqueue(id);
  }

  cancelJob(jobId: number): void {
    this.queue.cancel(jobId);
  }

  clearFinished(): void {
    this.queue.clearFinished();
  }

  async refreshConsole(): Promise<void> {
    await this.console.refresh();
  }

  /**
   * Removes a game (or only its update) with the system uninstaller, so the
   * home screen and app database stay consistent. Saved data is not touched.
   */
  async uninstall(titleId: string, what: UninstallTarget): Promise<void> {
    const item = this.console.find(titleId);
    if (!item) throw new AppError('notOnConsole');
    if (what === 'patch' && !item.patchVersion) throw new AppError('noPatchInstalled');
    if (!fs.existsSync(this.uninstallPayload)) throw new AppError('payloadMissing');
    const {ps4Ip} = this.config.get();
    const pcIp = lanIp(ps4Ip);
    if (!pcIp) throw new AppError('noLan');
    const r = await uninstallWithPayload({payloadPath: this.uninstallPayload, ps4Ip, pcIp, titleId, what});
    if (r.result) {
      throw new AppError(r.init ? 'uninstallRefusedInit' : 'uninstallRefused', {
        code: hex(r.result),
        init: hex(r.init),
      });
    }
    // Confirm on the console: the request alone does not prove it happened.
    // If the list cannot be read now, trust the uninstaller's success code.
    await new Promise(r => setTimeout(r, 1500));
    await this.console.settled();
    if (!(await this.console.refresh())) return;
    const after = this.console.find(titleId);
    if (what === 'patch' ? after?.patchVersion : after) throw new AppError('uninstallNotApplied');
  }
}
