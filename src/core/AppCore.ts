// Ties the services together: what the interface shows (state) and the
// actions it can take. Independent of Electron, so it can run headless too.
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  ACTIVE_JOB_STATES,
  type AddedPaths,
  type AppState,
  type ConfigPatch,
  type DeletePlan,
  type DeleteResult,
  type DiscoveredConsole,
  type Job,
  type Language,
  type LibraryItem,
  type PkgKind,
  type Ps4Status,
  type UninstallTarget,
  type UpdateStatus,
} from '@shared/types';
import {ConfigStore} from './config/ConfigStore';
import {ConsoleService, type RawConsoleItem} from './console/ConsoleService';
import {probeFtp} from './console/FtpClient';
import {KlogMonitor, type KlogEvent} from './console/KlogMonitor';
import {ActivityLog, redactHome} from './diagnostics/ActivityLog';
import {AppError, hex, toErrorInfo} from './errors';
import {InstallQueue} from './install/InstallQueue';
import {planDeletion, type DeleteTarget} from './library/DiskCleaner';
import {LibraryService, pkgId, type LibraryEntry} from './library/LibraryService';
import {discoverConsoles} from './network/discovery';
import {lanIp} from './network/lan';
import {
  InstallPayload,
  removeTaskWithPayload,
  TASK_NOT_FOUND,
  uninstallWithPayload,
  type ToolsTarget,
} from './payload/PayloadClient';
import {titleFor} from './pkg/PkgReader';
import {PkgFileServer} from './server/PkgFileServer';

export interface AppCoreOptions {
  configFile: string;
  /** Folder with install.bin and tools.bin. */
  payloadDir: string;
  /** Moves a file or folder to the system trash (deleting from the PC needs it). */
  trash?: (path: string) => Promise<void>;
  /** The user's own folders (home, Downloads…): never deleted as a game folder. */
  protectedDirs?: string[];
  systemLanguage: Language;
}

const STATUS_INTERVAL = 5000;

/** The PS4 keeps each DLC in a folder named after the end of its content ID (UP0000-CUSA00000_00-<label>). */
export const dlcLabel = (contentId: string | null | undefined): string | null =>
  /^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-([A-Z0-9]{16})$/.exec(contentId || '')?.[1] ?? null;
/** Order of a batch install: a game before its update and DLCs. */
const KIND_ORDER: Record<PkgKind, number> = {game: 0, app: 0, patch: 1, dlc: 2, other: 3};
/** Seconds between console re-reads after a download (about five minutes in total). */
const WATCH_DELAYS = [5, 10, 15, 20, 30, 30, 60, 60, 90];

export class AppCore extends EventEmitter<{change: []}> {
  readonly config: ConfigStore;
  readonly library: LibraryService;
  readonly console: ConsoleService;
  readonly server: PkgFileServer;
  readonly queue: InstallQueue;
  readonly log = new ActivityLog();
  /** Set by the Electron layer, which is the one that can update the app. */
  private updateStatus: UpdateStatus = {state: 'off'};
  private readonly klog: KlogMonitor;
  private consoleRefreshTimer: NodeJS.Timeout | null = null;
  private readonly installPayload: InstallPayload;
  private readonly toolsPayload: string;
  /** Jobs that send a game the PS4 did not have (see isNewGame), by job id. */
  private readonly newGames = new Map<number, boolean>();
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
    this.toolsPayload = path.join(options.payloadDir, 'tools.bin');
    this.queue = new InstallQueue({
      library: id => this.library.get(id),
      title: entry => this.title(entry),
      payload: this.installPayload,
      files: this.server,
      network: () => {
        const {ps4Ip} = this.config.get();
        return {ps4Ip, pcIp: lanIp(ps4Ip), port: this.server.port};
      },
      removeTask: (task, entry, job) => this.removeTask(task, entry, job),
      onChange: changed,
      // The log tells how the download goes: get it back if another program took it.
      onStart: () => this.klog.wake(),
      prepare: async job => {
        // Judged on the first try: a failed one may leave the game half there.
        if (!this.newGames.has(job.id)) this.newGames.set(job.id, await this.isNewGame(job));
      },
      onDownloaded: entry => void this.watchInstall(entry),
      log: message => this.log.add(message),
    });
    this.klog = new KlogMonitor(() => this.config.get().ps4Ip);
    this.klog.on('event', event => {
      this.log.add(`klog ${JSON.stringify(event)}`);
      this.onKlog(event);
    });
    this.klog.on('status', status => {
      this.log.add(`klog ${status}`);
      changed();
    });
  }

  /** Where the tools payload is and how it reaches back to this PC. */
  private toolsTarget(): ToolsTarget {
    const {ps4Ip} = this.config.get();
    if (!ps4Ip) throw new AppError('ps4NotConfigured');
    const pcIp = lanIp(ps4Ip);
    if (!pcIp) throw new AppError('noLan');
    return {payloadPath: this.toolsPayload, ps4Ip, pcIp};
  }

  /**
   * Whether a job sends a game (or app) the PS4 does not have. Its download
   * puts the game on the home screen right away, to be played while it
   * downloads; stopping it leaves that half-installed game behind.
   * Waits for the console list when it is still loading (the app just
   * opened); false when it cannot be read: never delete on a guess.
   */
  private async isNewGame(job: Job): Promise<boolean> {
    const info = this.library.get(job.pkgId)?.info;
    if (!info?.titleId || (info.kind !== 'game' && info.kind !== 'app')) return false;
    if (this.console.state(this.language).state !== 'ready') {
      await this.console.settled();
      if (this.console.state(this.language).state !== 'ready') await this.console.refresh();
      if (this.console.state(this.language).state !== 'ready') {
        this.log.add(`job ${job.id}: console list unreadable, a half-installed game would be kept`);
        return false;
      }
    }
    const isNew = !this.console.find(info.titleId);
    this.log.add(`job ${job.id}: ${info.titleId} ${isNew ? 'is new on the PS4' : 'is already on the PS4'}`);
    return isNew;
  }

  /**
   * Removes a stopped download from the PS4 list, so no failed entry stays in
   * its notifications, and the half-installed game it leaves when the game
   * was not on the PS4 before.
   */
  private async removeTask(task: string | null, entry: LibraryEntry, job: Job): Promise<boolean> {
    const contentId = entry.info.contentId || '';
    if (!task && !contentId) return false;
    let removed: boolean;
    try {
      const r = await removeTaskWithPayload({...this.toolsTarget(), task, contentId});
      this.log.add(`remove download ${task ?? contentId}: stop ${hex(r.stop)}, unregister ${hex(r.unregister)}`);
      // Not found by content ID: there is nothing left to remove.
      removed = r.unregister === 0 || (!task && r.stop === TASK_NOT_FOUND);
    } catch (e) {
      this.log.add(`remove download ${task ?? contentId} failed: ${JSON.stringify(toErrorInfo(e))}`);
      return false;
    }
    const titleId = entry.info.titleId;
    // Not re-checked on the console now: the half-installed game may show
    // there (its folder exists on internal storage) as if it were installed.
    if (!removed || !titleId || !this.newGames.get(job.id)) return removed;
    try {
      await new Promise(r => setTimeout(r, 1000));
      const r = await uninstallWithPayload({...this.toolsTarget(), titleId, what: 'game'});
      this.log.add(`remove half-installed ${titleId}: init ${hex(r.init)}, result ${hex(r.result)}`);
      this.refreshConsoleSoon();
      return r.result === 0;
    } catch (e) {
      this.log.add(`remove half-installed ${titleId} failed: ${JSON.stringify(toErrorInfo(e))}`);
      return false;
    }
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

  get update(): UpdateStatus {
    return this.updateStatus;
  }

  setUpdate(status: UpdateStatus): void {
    this.updateStatus = status;
    if (status.state === 'error' || status.state === 'ready') {
      this.log.add(
        `update ${status.state} ${status.version ?? ''} ${status.error ? JSON.stringify(status.error) : ''}`,
      );
    }
    this.emit('change');
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
      this.log.add(`ps4 ${ps4Ip || '-'} ${next}`);
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

  /**
   * What "install all updates" sends: for each game on the PS4, the newest
   * update in the library when it is newer than the installed one, and the
   * DLCs it does not have yet.
   */
  private pendingUpdates(items: LibraryItem[]): string[] {
    const active = new Set(this.queue.jobs.filter(j => ACTIVE_JOB_STATES.includes(j.state)).map(j => j.pkgId));
    const usable = items.filter(i => !i.error && i.titleId && !active.has(i.id));
    const newest = new Map<string, LibraryItem>();
    for (const i of usable) {
      if (i.kind !== 'patch' || !i.newer) continue;
      const best = newest.get(i.titleId!);
      if (!best || (i.version || '') > (best.version || '')) newest.set(i.titleId!, i);
    }
    const dlcs = usable.filter(i => i.kind === 'dlc' && i.installed === false && this.console.find(i.titleId!));
    return [...newest.values(), ...dlcs].map(i => i.id);
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
    const library = entries
      .map(e => this.publicItem(e, entries))
      .sort((a, b) => a.title.localeCompare(b.title, language) || (b.version || '').localeCompare(a.version || ''));
    const consoleState = this.console.state(language);
    return {
      config: {
        ps4Ip: config.ps4Ip,
        ftpPort: config.ftpPort,
        language: config.language,
        folders: config.folders,
        autoUpdate: config.autoUpdate,
      },
      language,
      lanIp: lanIp(config.ps4Ip),
      ps4: this.ps4,
      scan: {...this.library.scan, missing: [...this.library.scan.missing]},
      library,
      console: consoleState,
      jobs: this.queue.jobs.map(j => ({...j})),
      updates: consoleState.state === 'ready' ? this.pendingUpdates(library) : [],
      klog: this.klog.status,
      update: this.updateStatus,
      payloads: {install: this.installPayload.available, tools: fs.existsSync(this.toolsPayload)},
    };
  }

  /** Report for bug reports: versions, connections and recent events, without personal paths. */
  diagnostics(about: Record<string, string>): string {
    const state = this.getState();
    const config = this.config.get();
    const payload = (name: string) => {
      const file = path.join(this.options.payloadDir, name);
      return fs.existsSync(file) ? `${fs.statSync(file).size} bytes` : 'missing';
    };
    const jobs = state.jobs.map(j =>
      [
        `#${j.id} ${j.state}, attempt ${j.attempt}, ${j.transferred}/${j.total} bytes`,
        j.taskId && `task ${j.taskId}`,
        j.cleanup && `cleanup ${j.cleanup}`,
        j.error && `${j.error.code} ${JSON.stringify(j.error.params ?? {})}`,
      ]
        .filter(Boolean)
        .join(', '),
    );
    const kinds: Record<string, number> = {};
    for (const i of state.library) kinds[i.kind] = (kinds[i.kind] ?? 0) + 1;
    const c = state.console;
    const lines = [
      'PKGo diagnostics',
      ...Object.entries(about).map(([k, v]) => `${k}: ${v}`),
      `language: ${state.language}`,
      '',
      '[console]',
      `ps4: ${config.ps4Ip || '-'} (${state.ps4}), ftp port ${config.ftpPort}`,
      `pc lan ip: ${state.lanIp ?? '-'}, pkg server port ${this.server.port}`,
      `ps4 log (klog): ${state.klog}`,
      `updates: ${state.update.state}${state.update.version ? ` ${state.update.version}` : ''}, automatic ${config.autoUpdate}`,
      `console list: ${c.state}, ${c.items.length} titles${c.error ? `, error ${JSON.stringify(c.error)}` : ''}`,
      `payloads: install.bin ${payload('install.bin')}, tools.bin ${payload('tools.bin')}`,
      '',
      '[library]',
      `folders: ${config.folders.length} (${state.scan.missing.length} missing), files: ${config.files.length}, hidden: ${config.hidden.length}`,
      `packages: ${state.library.length} ${JSON.stringify(kinds)}, unreadable: ${state.library.filter(i => i.error).length}`,
      `pending updates: ${state.updates.length}`,
      '',
      '[jobs]',
      ...(jobs.length ? jobs : ['none']),
      '',
      '[recent events]',
      ...this.log.recent,
    ];
    return redactHome(lines.join('\n'));
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

  /** Adds dropped paths: folders to the folder list, .pkg files one by one. */
  async addPaths(paths: string[]): Promise<AddedPaths> {
    const folders: string[] = [];
    const files: string[] = [];
    for (const p of paths) {
      const stat = await fs.promises.stat(p).catch(() => null);
      if (stat?.isDirectory()) folders.push(p);
      else if (stat?.isFile() && p.toLowerCase().endsWith('.pkg')) files.push(p);
    }
    if (!folders.length && !files.length) throw new AppError('nothingToAdd');
    const added = {folders: folders.length ? await this.addFolders(folders) : 0, files: 0};
    if (files.length) added.files = await this.addFiles(files);
    return added;
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

  /** Deletion plan for library items, leaving out the ones being sent to the PS4. */
  private async deletion(ids: string[]): Promise<{targets: DeleteTarget[]; busy: number}> {
    const sending = new Set(this.queue.jobs.filter(j => ACTIVE_JOB_STATES.includes(j.state)).map(j => j.pkgId));
    const entries = [...new Set(ids)].map(id => this.library.get(id)).filter(e => e !== undefined);
    const free = entries.filter(e => !sending.has(e.id));
    const protectedDirs = [...(this.options.protectedDirs ?? []), ...this.config.get().folders.map(f => f.path)];
    const targets = await planDeletion(free, protectedDirs);
    return {targets, busy: entries.length - free.length};
  }

  async planDelete(ids: string[]): Promise<DeletePlan> {
    const {targets, busy} = await this.deletion(ids);
    return {
      targets: targets.map(({path, folder, size}) => ({path, folder, size})),
      size: targets.reduce((sum, t) => sum + t.size, 0),
      busy,
    };
  }

  /** Moves library PKGs (or their own folders) to the trash and drops them from the library. */
  async deleteFromDisk(ids: string[]): Promise<DeleteResult> {
    const trash = this.options.trash;
    if (!trash) throw new AppError('trashUnavailable');
    // Planned again: files may have changed since the confirmation was shown.
    const {targets} = await this.deletion(ids);
    const failed: string[] = [];
    const gone: string[] = [];
    for (const target of targets) {
      try {
        await trash(target.path);
        gone.push(...target.ids);
        this.log.add(`trashed ${target.folder ? 'folder' : 'file'} ${target.path}`);
      } catch (e) {
        failed.push(target.path);
        this.log.add(`trash ${target.path} failed: ${JSON.stringify(toErrorInfo(e))}`);
      }
    }
    if (gone.length) {
      const removed = new Set(gone.map(id => this.library.get(id)?.path).filter(p => p !== undefined));
      const {files} = this.config.get();
      this.config.update({files: files.filter(f => !removed.has(path.resolve(f)))});
      for (const id of gone) this.library.delete(id);
    }
    return {deleted: gone.length, failed};
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

  /** Queues every pending update and DLC (AppState.updates); returns how many. */
  installUpdates(): number {
    return this.installMany(this.getState().updates);
  }

  /**
   * Queues several packages: games and apps first, then updates, then DLCs,
   * so each game is on the PS4 before its add-ons. Skips the ones that cannot
   * be queued (unreadable, gone, already queued); returns how many were.
   */
  installMany(ids: string[]): number {
    const rank = (id: string) => KIND_ORDER[this.library.get(id)?.info.kind || 'other'];
    let queued = 0;
    for (const id of [...new Set(ids)].sort((a, b) => rank(a) - rank(b))) {
      try {
        this.queue.enqueue(id);
        queued++;
      } catch {
        // Removed, unreadable or queued meanwhile: skip it.
      }
    }
    return queued;
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
    const r = await uninstallWithPayload({...this.toolsTarget(), titleId, what});
    this.log.add(`uninstall ${titleId} ${what}: init ${hex(r.init)}, result ${hex(r.result)}`);
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
