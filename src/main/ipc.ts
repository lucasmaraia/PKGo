// IPC handlers: one channel per Api method (see src/shared/types.ts). Replies
// carry errors as data (IpcResult), since Electron drops custom error fields.
import os from 'node:os';
import {app, clipboard, ipcMain, type BrowserWindow} from 'electron';
import type {AppCore} from '@core/AppCore';
import {toErrorInfo} from '@core/errors';
import type {ConfigPatch, IpcResult, UninstallTarget} from '@shared/types';
import {pickFiles, pickFolders} from './dialogs';

/** Longest wait between two state updates sent to the window. */
const STATE_THROTTLE = 200;

export function registerIpc(core: AppCore, getWindow: () => BrowserWindow | null): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) => {
    ipcMain.handle(channel, async (_event, ...args: unknown[]): Promise<IpcResult<Awaited<R>>> => {
      try {
        return {ok: true, value: await fn(...(args as A))};
      } catch (e) {
        return {ok: false, error: toErrorInfo(e)};
      }
    });
  };
  const win = () => getWindow() ?? undefined;
  const language = () => core.language;

  handle('getState', () => core.getState());
  handle('setConfig', (patch: ConfigPatch) => core.setConfig(patch));
  handle('addFolders', async () => core.addFolders(await pickFolders(win(), language())));
  handle('removeFolder', (folder: string) => core.removeFolder(folder));
  handle('setFolderRecursive', (folder: string, recursive: boolean) => core.setFolderRecursive(folder, recursive));
  handle('addFiles', async () => core.addFiles(await pickFiles(win(), language())));
  handle('addPaths', (paths: string[]) => core.addPaths(paths.filter(p => typeof p === 'string' && p)));
  handle('rescan', () => core.rescan());
  handle('removeFromLibrary', (id: string) => core.removeFromLibrary(id));
  handle('install', (id: string) => core.install(id));
  handle('installUpdates', () => core.installUpdates());
  handle('installMany', (ids: string[]) =>
    core.installMany(Array.isArray(ids) ? ids.filter(i => typeof i === 'string') : []),
  );
  handle('cancelJob', (jobId: number) => core.cancelJob(jobId));
  handle('clearFinished', () => core.clearFinished());
  handle('refreshConsole', () => core.refreshConsole());
  handle('uninstall', (titleId: string, what: UninstallTarget) => core.uninstall(titleId, what));
  handle('discover', () => core.discover());
  handle('copyDiagnostics', () =>
    clipboard.writeText(
      core.diagnostics({
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        system: `${os.type()} ${os.release()} ${os.arch()}`,
        packaged: String(app.isPackaged),
      }),
    ),
  );

  // Push state changes, at most every STATE_THROTTLE ms.
  let timer: NodeJS.Timeout | null = null;
  core.on('change', () => {
    timer ??= setTimeout(() => {
      timer = null;
      const w = getWindow();
      if (w && !w.isDestroyed()) w.webContents.send('state', core.getState());
    }, STATE_THROTTLE);
  });
}
