// Lists what is installed on the PS4 through the GoldHEN FTP server:
// /user/app (games and apps), /user/patch (updates), /user/addcont (DLC)
// and /user/appmeta (icons). Title and version come from the installed PKG headers.
import {FtpClient} from './ftp.mjs';
import {readPkgMeta} from './pkg.mjs';

const TITLE_ID = /^[A-Z]{4}\d{5}$/;

export async function readConsoleLibrary({host, port, cache, icons, onProgress}) {
  let ftp = await new FtpClient(host, port).connect();
  const session = async () => {
    if (ftp.dirty) { ftp.close(); ftp = await new FtpClient(host, port).connect(); }
    return ftp;
  };
  const optional = async fn => {
    try { return await fn(await session()); } catch (e) {
      if (!e.code) { ftp.close(); ftp = await new FtpClient(host, port).connect(); }
      return null;
    }
  };
  const pkgMeta = (file, fallback) => optional(f => readPkgMeta(
    async (offset, length) => {
      const c = await session();
      const buf = await c.read(file, offset, length);
      if (buf.length !== length) throw new Error('leitura incompleta');
      return buf;
    }, fallback, {images: false}));
  // Total size of the files under `dir`, `depth` folder levels down.
  const du = async (dir, depth) => {
    let total = 0;
    for (const e of (await optional(f => f.entries(dir))) || []) {
      total += e.dir ? (depth > 0 ? await du(`${dir}/${e.name}`, depth - 1) : 0) : e.size;
    }
    return total;
  };

  try {
    const apps = (await (await session()).list('/user/app')).filter(n => TITLE_ID.test(n)).sort();
    const patches = new Set((await optional(f => f.list('/user/patch'))) || []);
    const addcont = new Set((await optional(f => f.list('/user/addcont'))) || []);
    const items = [];
    for (const [index, id] of apps.entries()) {
      onProgress?.(index, apps.length);
      const appSize = (await optional(f => f.sizes(`/user/app/${id}`)))?.get('app.pkg') ?? null;
      const patchSize = patches.has(id) ? (await optional(f => f.sizes(`/user/patch/${id}`)))?.get('patch.pkg') ?? null : null;
      const key = `${id}:${appSize}:${patchSize}`;
      let item = cache.get(key);
      if (!item) {
        const base = appSize ? await pkgMeta(`/user/app/${id}/app.pkg`, id) : null;
        const patch = patchSize ? await pkgMeta(`/user/patch/${id}/patch.pkg`, id) : null;
        item = {
          titleId: id,
          title: base?.title || patch?.title || id,
          kind: base?.kind || 'app', kindLabel: base?.kindLabel || 'App',
          baseVersion: base?.version || null,
          patchVersion: patch?.version || null,
          version: patch?.version || base?.version || null,
          size: (appSize || 0) + (patchSize || 0),
        };
        cache.set(key, item);
      }
      if (!icons.has(id)) {
        const icon = await optional(f => f.read(`/user/appmeta/${id}/icon0.png`));
        if (icon?.length) icons.set(id, icon);
      }
      // DLC is read on every refresh: it can be installed without touching the game.
      const dlcs = addcont.has(id) ? ((await optional(f => f.entries(`/user/addcont/${id}`))) || []).filter(e => e.dir) : [];
      let dlcSize = 0;
      for (const d of dlcs) dlcSize += await du(`/user/addcont/${id}/${d.name}`, 0);
      items.push({...item, appSize: appSize || 0, patchSize: patchSize || 0, dlcCount: dlcs.length, dlcSize, hasIcon: icons.has(id)});
    }
    onProgress?.(apps.length, apps.length);

    // Space used per category, like Settings > Storage. The FTP server has no
    // command for free space or capacity, so those stay unknown.
    let saved = 0;
    for (const user of ((await optional(f => f.entries('/user/home'))) || []).filter(e => e.dir)) {
      saved += await du(`/user/home/${user.name}/savedata`, 1);
    }
    const sum = key => items.reduce((total, i) => total + i[key], 0);
    const storage = [
      {key: 'apps', label: 'Jogos e apps', size: sum('appSize')},
      {key: 'patch', label: 'Atualizações', size: sum('patchSize')},
      {key: 'dlc', label: 'Conteúdo adicional', size: sum('dlcSize')},
      {key: 'saved', label: 'Dados salvos', size: saved},
      {key: 'captures', label: 'Capturas', size: await du('/user/av_contents/photo', 3) + await du('/user/av_contents/video', 3)},
    ];
    return {items, storage};
  } finally {
    ftp.close();
  }
}
