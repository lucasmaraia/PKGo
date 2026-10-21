// Types shared by the core, the Electron main process and the renderer.
// Text shown to people is never built here: errors and labels travel as codes
// and the renderer translates them.

export const LANGUAGES = ['pt-BR', 'en', 'es'] as const;
export type Language = (typeof LANGUAGES)[number];

export type PkgKind = 'game' | 'patch' | 'dlc' | 'app' | 'other';

/** An error code plus values to fill into its translated message. */
export interface ErrorInfo {
  code: string;
  params?: Record<string, string | number>;
}

export interface FolderEntry {
  path: string;
  /** Also look for PKGs in every subfolder. */
  recursive: boolean;
}

export interface PublicConfig {
  ps4Ip: string;
  ftpPort: number;
  /** null follows the system language. */
  language: Language | null;
  folders: FolderEntry[];
}

export interface LibraryItem {
  id: string;
  name: string;
  path: string;
  size: number;
  error: ErrorInfo | null;
  title: string;
  titleId: string | null;
  contentId: string | null;
  version: string | null;
  kind: PkgKind;
  category: string | null;
  firmware: string | null;
  hasIcon: boolean;
  /** Library item whose icon this one shows (updates borrow the game's). */
  iconId: string | null;
  hasPic: boolean;
  /** null = unknown: console list not loaded yet, or a DLC. */
  installed: boolean | null;
  installedVersion: string | null;
  newer: boolean;
}

export type JobState = 'queued' | 'starting' | 'installing' | 'done' | 'error' | 'cancelled';
export const ACTIVE_JOB_STATES: readonly JobState[] = ['queued', 'starting', 'installing'];
/** Tries per download: the first one plus automatic retries. */
export const MAX_ATTEMPTS = 3;

export interface Job {
  id: number;
  pkgId: string;
  title: string;
  state: JobState;
  total: number;
  transferred: number;
  /** Bytes per second. */
  speed: number;
  /** Seconds left. */
  eta: number | null;
  error: ErrorInfo | null;
  createdAt: number;
  /** 1 on the first try; failed downloads are sent again a few times. */
  attempt: number;
  /** Waiting to be sent again (after a failed attempt) until this time. */
  retryAt?: number;
  /**
   * Removing the stopped download from the PS4 list (and its notification):
   * 'failed' means it is still there for the user to delete.
   */
  cleanup?: 'running' | 'done' | 'failed';
  /** The PS4 download task, once its log reports it. */
  taskId?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** Internal drive or extended (USB) storage. */
export type ConsoleStorage = 'internal' | 'external';

export interface ConsoleItem {
  titleId: string;
  title: string;
  kind: PkgKind;
  baseVersion: string | null;
  patchVersion: string | null;
  version: string | null;
  /** Game plus installed update. */
  size: number;
  appSize: number;
  patchSize: number;
  dlcCount: number;
  /** Installed DLC labels: the last part of each DLC's content ID. */
  dlcs: string[];
  storage: ConsoleStorage;
  hasIcon: boolean;
}

export interface ConsoleState {
  state: 'idle' | 'loading' | 'ready' | 'error';
  refreshing: boolean;
  items: ConsoleItem[];
  done: number;
  total: number;
  error: ErrorInfo | null;
  updatedAt: number;
}

export type Ps4Status = 'unconfigured' | 'checking' | 'offline' | 'ready';

/**
 * Connection to the PS4 log, which tells what happens to downloads as it
 * happens. 'busy': another program is reading it (the PS4 serves one reader);
 * 'unavailable': the log server does not answer (disabled in GoldHEN).
 */
export type KlogStatus = 'off' | 'connecting' | 'live' | 'busy' | 'unavailable';

export interface ScanState {
  active: boolean;
  folders: number;
  found: number;
  /** Configured folders that do not exist (or cannot be opened) anymore. */
  missing: string[];
}

export interface DiscoveredConsole {
  ip: string;
  name: string | null;
  /** From the PS4 discovery protocol; null when found only by its FTP server. */
  status: 'on' | 'standby' | null;
  /** The GoldHEN FTP server answered. */
  goldhen: boolean;
}

export interface AppState {
  config: PublicConfig;
  /** Language in use: the configured one or the system's. */
  language: Language;
  lanIp: string | null;
  ps4: Ps4Status;
  scan: ScanState;
  library: LibraryItem[];
  console: ConsoleState;
  jobs: Job[];
  /** Library updates and DLCs missing on the PS4, for "install all" (ids). */
  updates: string[];
  klog: KlogStatus;
  payloads: {install: boolean; tools: boolean};
}

export interface AddedPaths {
  folders: number;
  files: number;
}

export type UninstallTarget = 'game' | 'patch';

export interface ConfigPatch {
  ps4Ip?: string;
  ftpPort?: number;
  language?: Language | null;
}

/** API exposed to the renderer by the preload script (window.api). */
export interface Api {
  version: string;
  getState(): Promise<AppState>;
  onState(listener: (state: AppState) => void): () => void;
  setConfig(patch: ConfigPatch): Promise<void>;
  addFolders(): Promise<number>;
  removeFolder(path: string): Promise<void>;
  setFolderRecursive(path: string, recursive: boolean): Promise<void>;
  addFiles(): Promise<number>;
  /** Adds dropped folders and PKG files. */
  addPaths(paths: string[]): Promise<AddedPaths>;
  /** Path on disk of a dropped file (the renderer cannot read it itself). */
  pathForFile(file: File): string;
  rescan(): Promise<void>;
  removeFromLibrary(id: string): Promise<void>;
  install(id: string): Promise<void>;
  /** Queues every entry of AppState.updates; returns how many were queued. */
  installUpdates(): Promise<number>;
  cancelJob(jobId: number): Promise<void>;
  clearFinished(): Promise<void>;
  refreshConsole(): Promise<void>;
  uninstall(titleId: string, what: UninstallTarget): Promise<void>;
  discover(): Promise<DiscoveredConsole[]>;
  /** Copies a diagnostic report (versions, connections, recent events) to the clipboard. */
  copyDiagnostics(): Promise<void>;
}

/** IPC replies carry errors as data: Electron drops custom fields of thrown errors. */
export type IpcResult<T> = {ok: true; value: T} | {ok: false; error: ErrorInfo};
