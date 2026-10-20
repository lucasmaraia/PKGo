// Lists what is installed on the PS4 through the GoldHEN FTP server:
// /user/app (games and apps), /user/patch (updates), /user/addcont (DLC)
// and /user/appmeta (icons). Title and version come from the installed PKG headers.
import type {ConsoleItem, ConsoleState, Language, PkgKind} from '@shared/types';
import {AppError, toErrorInfo} from '../errors';
import {readPkgMeta, titleFor, type Titles} from '../pkg/PkgReader';
import {FtpClient, FtpError, type FtpEntry} from './FtpClient';

const TITLE_ID = /^[A-Z]{4}\d{5}$/;

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

  try {
    const apps = (await (await session()).list('/user/app')).filter(n => TITLE_ID.test(n)).sort();
    const patches = new Set((await optional(f => f.list('/user/patch'))) || []);
    const addcont = new Set((await optional(f => f.list('/user/addcont'))) || []);
    const items: RawConsoleItem[] = [];
    for (const [index, id] of apps.entries()) {
      onProgress?.(index, apps.length);
      const appSize = (await optional(f => f.sizes(`/user/app/${id}`)))?.get('app.pkg') ?? 0;
      const patchSize = patches.has(id)
        ? ((await optional(f => f.sizes(`/user/patch/${id}`)))?.get('patch.pkg') ?? 0)
        : 0;
      const key = `${id}:${appSize}:${patchSize}`;
      let meta = cache.get(key);
      if (!meta) {
        const base = appSize ? await pkgMeta(`/user/app/${id}/app.pkg`, id) : null;
        const patch = patchSize ? await pkgMeta(`/user/patch/${id}/patch.pkg`, id) : null;
        meta = {
          titles: base?.titles || patch?.titles || {default: id},
          kind: base?.kind || 'app',
          baseVersion: base?.version || null,
          patchVersion: patch?.version || null,
        };
        cache.set(key, meta);
      }
      if (!icons.has(id)) {
        const icon = await optional(f => f.read(`/user/appmeta/${id}/icon0.png`, 0, Infinity));
        if (icon?.length) icons.set(id, icon);
      }
      // DLC is read on every refresh: it can be installed without touching the game.
      const dlcs = addcont.has(id) ? dirs(await optional(f => f.entries(`/user/addcont/${id}`))) : [];
      items.push({
        titleId: id,
        ...meta,
        version: meta.patchVersion || meta.baseVersion,
        size: appSize + patchSize,
        appSize,
        patchSize,
        dlcCount: dlcs.length,
        hasIcon: icons.has(id),
      });
    }
    onProgress?.(apps.length, apps.length);
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
  private loading: Promise<void> | null = null;
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

  refresh(): Promise<void> {
    const {host, port} = this.target();
    if (!host) return Promise.resolve();
    this.loading ??= (async () => {
      this.status.state = this.status.updatedAt ? 'ready' : 'loading';
      this.status.refreshing = true;
      this.status.error = null;
      this.onChange();
      try {
        this.raw = await readConsoleLibrary({
          host,
          port,
          cache: this.cache,
          icons: this.icons,
          onProgress: (done, total) => {
            Object.assign(this.status, {done, total});
            this.onChange();
          },
        });
        Object.assign(this.status, {state: 'ready', updatedAt: Date.now()});
      } catch (e) {
        this.status.error = new AppError('consoleFtp', {detail: toErrorInfo(e).params?.detail ?? String(e)}).toInfo();
        if (!this.status.updatedAt) this.status.state = 'error';
      } finally {
        this.status.refreshing = false;
        this.loading = null;
        this.onChange();
      }
    })();
    return this.loading;
  }
}
