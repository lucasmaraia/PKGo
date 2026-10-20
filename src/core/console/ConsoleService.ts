// Lists what is installed on the PS4 through the GoldHEN FTP server, on the
// internal drive and on extended (USB) storage: <root>/user/app (games and
// apps), <root>/user/patch (updates) and <root>/user/addcont (DLC). Icons are
// in /user/appmeta, or /user/appmeta/external for extended storage. Title and
// version come from the installed PKG headers.
import type {ConsoleItem, ConsoleState, ConsoleStorage, Language, PkgKind} from '@shared/types';
import {AppError, toErrorInfo} from '../errors';
import {readPkgMeta, titleFor, type Titles} from '../pkg/PkgReader';
import {FtpClient, FtpError, type FtpEntry} from './FtpClient';

const TITLE_ID = /^[A-Z]{4}\d{5}$/;

interface Storage {
  kind: ConsoleStorage;
  /** Prefix of its user/app, user/patch and user/addcont folders. */
  root: string;
  appmeta: string;
}

/** Internal drive first: a title found on both counts as internal. */
export const STORAGES: Storage[] = [
  {kind: 'internal', root: '', appmeta: '/user/appmeta'},
  {kind: 'external', root: '/mnt/ext0', appmeta: '/user/appmeta/external'},
  {kind: 'external', root: '/mnt/ext1', appmeta: '/user/appmeta/external'},
];

/** What is known about an installed title; cached while its PKG sizes stay the same. */
interface TitleMeta {
  titles: Titles;
  kind: PkgKind;
  baseVersion: string | null;
  patchVersion: string | null;
}

export interface RawConsoleItem extends Omit<ConsoleItem, 'title'> {
  titles: Titles;
}

export interface ReadOptions {
  host: string;
  port: number;
  cache: Map<string, TitleMeta>;
  icons: Map<string, Buffer>;
  onProgress?: (done: number, total: number) => void;
}

export async function readConsoleLibrary({host, port, cache, icons, onProgress}: ReadOptions) {
  let ftp = await new FtpClient(host, port).connect();
  const reconnect = async () => {
    ftp.close();
    ftp = await new FtpClient(host, port).connect();
  };
  const session = async () => {
    if (ftp.dirty) await reconnect();
    return ftp;
  };
  // A missing folder or file is normal (FTP error reply); a dropped connection is not.
  const optional = async <T>(fn: (f: FtpClient) => Promise<T>): Promise<T | null> => {
    try {
      return await fn(await session());
    } catch (e) {
      if (!(e instanceof FtpError)) await reconnect();
      return null;
    }
  };
  const pkgMeta = (file: string, fallback: string) =>
    optional(() =>
      readPkgMeta(
        async (offset, length) => {
          const buf = await (await session()).read(file, offset, length);
          if (buf.length !== length) throw new Error('short read');
          return buf;
        },
        fallback,
        {images: false},
      ),
    );
  const dirs = (entries: FtpEntry[] | null) => (entries || []).filter(e => e.dir);
  const titleIds = (names: string[] | null) => (names || []).filter(n => TITLE_ID.test(n));

  try {
    // Where each title's game, update and DLC are. The internal app folder must
    // be readable (that proves the FTP server works); the others may not exist.
    const apps = new Map<string, Storage>();
    const patches = new Map<string, Storage>();
    const addcont = new Map<string, Storage[]>();
    for (const storage of STORAGES) {
      const list =
        storage.kind === 'internal'
          ? await (await session()).list('/user/app')
          : await optional(f => f.list(`${storage.root}/user/app`));
      for (const id of titleIds(list)) if (!apps.has(id)) apps.set(id, storage);
      for (const id of titleIds(await optional(f => f.list(`${storage.root}/user/patch`)))) {
        if (!patches.has(id)) patches.set(id, storage);
      }
      for (const id of titleIds(await optional(f => f.list(`${storage.root}/user/addcont`)))) {
        addcont.set(id, [...(addcont.get(id) || []), storage]);
      }
    }

    const ids = [...apps.keys()].sort();
    const items: RawConsoleItem[] = [];
    for (const [index, id] of ids.entries()) {
      onProgress?.(index, ids.length);
      const storage = apps.get(id)!;
      const patchStorage = patches.get(id);
      const appDir = `${storage.root}/user/app/${id}`;
      const patchDir = patchStorage ? `${patchStorage.root}/user/patch/${id}` : null;
      const appSize = (await optional(f => f.sizes(appDir)))?.get('app.pkg') ?? 0;
      const patchSize = patchDir ? ((await optional(f => f.sizes(patchDir)))?.get('patch.pkg') ?? 0) : 0;
      const key = `${appDir}:${appSize}:${patchSize}`;
      let meta = cache.get(key);
      if (!meta) {
        const base = appSize ? await pkgMeta(`${appDir}/app.pkg`, id) : null;
        const patch = patchSize && patchDir ? await pkgMeta(`${patchDir}/patch.pkg`, id) : null;
        meta = {
          titles: base?.titles || patch?.titles || {default: id},
          kind: base?.kind || 'app',
          baseVersion: base?.version || null,
          patchVersion: patch?.version || null,
        };
        cache.set(key, meta);
      }
      if (!icons.has(id)) {
        const icon = await optional(f => f.read(`${storage.appmeta}/${id}/icon0.png`, 0, Infinity));
        if (icon?.length) icons.set(id, icon);
      }
      // DLC is read on every refresh: it can be installed without touching the game.
      const dlcs: string[] = [];
      for (const s of addcont.get(id) || []) {
        dlcs.push(...dirs(await optional(f => f.entries(`${s.root}/user/addcont/${id}`))).map(e => e.name));
      }
      items.push({
        titleId: id,
        ...meta,
        version: meta.patchVersion || meta.baseVersion,
        size: appSize + patchSize,
        appSize,
        patchSize,
        dlcCount: dlcs.length,
        dlcs,
        storage: storage.kind,
        hasIcon: icons.has(id),
      });
    }
    onProgress?.(ids.length, ids.length);
    return items;
  } finally {
    ftp.close();
  }
}

/** Keeps the console list, refreshing it on demand (one read at a time). */
export class ConsoleService {
  private raw: RawConsoleItem[] = [];
  private cache = new Map<string, TitleMeta>();
  readonly icons = new Map<string, Buffer>();
  private loading: Promise<boolean> | null = null;
  /** Bumped by reset(): results of reads started before it are dropped. */
  private generation = 0;
  private loadingGeneration = -1;
  private status: Omit<ConsoleState, 'items'> = {
    state: 'idle',
    refreshing: false,
    done: 0,
    total: 0,
    error: null,
    updatedAt: 0,
  };

  constructor(
    private readonly target: () => {host: string; port: number},
    private readonly onChange: () => void,
  ) {}

  get items(): RawConsoleItem[] {
    return this.raw;
  }

  find(titleId: string): RawConsoleItem | undefined {
    return this.raw.find(i => i.titleId === titleId);
  }

  state(language: Language): ConsoleState {
    const items = this.raw.map(({titles, ...rest}) => ({...rest, title: titleFor(titles, language)}));
    return {...this.status, items};
  }

  /** Forgets everything, e.g. when the console IP changes. */
  reset(): void {
    this.generation++;
    this.raw = [];
    this.cache.clear();
    this.icons.clear();
    this.status = {...this.status, state: 'idle', updatedAt: 0, error: null};
    this.onChange();
  }

  /** Waits for a read in progress, if any. */
  async settled(): Promise<void> {
    await this.loading;
  }

  /** Reads the console list again; resolves to whether it succeeded. */
  refresh(): Promise<boolean> {
    const {host, port} = this.target();
    if (!host) return Promise.resolve(false);
    // A read for an older console (before reset) does not count: start a new one.
    if (this.loading && this.loadingGeneration === this.generation) return this.loading;
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.loadingGeneration = generation;
    const loading = (async (): Promise<boolean> => {
      this.status.state = this.status.updatedAt ? 'ready' : 'loading';
      this.status.refreshing = true;
      this.status.error = null;
      this.onChange();
      try {
        const items = await readConsoleLibrary({
          host,
          port,
          cache: this.cache,
          icons: this.icons,
          onProgress: (done, total) => {
            if (!current()) return;
            Object.assign(this.status, {done, total});
            this.onChange();
          },
        });
        if (!current()) return false;
        this.raw = items;
        Object.assign(this.status, {state: 'ready', updatedAt: Date.now()});
        return true;
      } catch (e) {
        if (!current()) return false;
        this.status.error = new AppError('consoleFtp', {detail: toErrorInfo(e).params?.detail ?? String(e)}).toInfo();
        if (!this.status.updatedAt) this.status.state = 'error';
        return false;
      } finally {
        // Only the latest read clears the busy state; an outdated one just ends.
        if (this.loadingGeneration === generation) {
          this.loading = null;
          this.status.refreshing = false;
          this.onChange();
        }
      }
    })();
    this.loading = loading;
    return loading;
  }
}
