// Exposes the typed API (src/shared/types.ts) as window.api. The renderer has
// no Node access: everything goes through these IPC calls.
import {contextBridge, ipcRenderer, webUtils, type IpcRendererEvent} from 'electron';
import type {Api, AppState, IpcResult} from '@shared/types';

// Failed calls reject with the ErrorInfo object ({code, params}) so the
// renderer can translate it.
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.ok) throw result.error;
  return result.value;
}

const version = process.argv.find(arg => arg.startsWith('--app-version='))?.split('=')[1] ?? '';

const api: Api = {
  version,
  getState: () => call('getState'),
  onState: listener => {
    const handler = (_event: IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.off('state', handler);
  },
  setConfig: patch => call('setConfig', patch),
  addFolders: () => call('addFolders'),
  removeFolder: folder => call('removeFolder', folder),
  setFolderRecursive: (folder, recursive) => call('setFolderRecursive', folder, recursive),
  addFiles: () => call('addFiles'),
  addPaths: paths => call('addPaths', paths),
  pathForFile: file => webUtils.getPathForFile(file),
  rescan: () => call('rescan'),
  removeFromLibrary: id => call('removeFromLibrary', id),
  install: id => call('install', id),
  installUpdates: () => call('installUpdates'),
  installMany: ids => call('installMany', ids),
  cancelJob: jobId => call('cancelJob', jobId),
  clearFinished: () => call('clearFinished'),
  refreshConsole: () => call('refreshConsole'),
  uninstall: (titleId, what) => call('uninstall', titleId, what),
  discover: () => call('discover'),
  copyDiagnostics: () => call('copyDiagnostics'),
};

contextBridge.exposeInMainWorld('api', api);
