// Renderer entry: receives state from the main process, renders every view
// and turns clicks into API calls.
import type {AppState} from '@shared/types';
import {$, $$} from './dom';
import {errorText, setLanguage, t} from './i18n';
import {initNavigation} from './navigation';
import {store, type Filter, type View} from './store';
import {invalidateActivity, notifyTransitions, renderActivity} from './views/activity';
import {invalidateConsole, renderConsole} from './views/console';
import {closeDetails, initDetails, invalidateDetails, openDetails, renderDetails} from './views/details';
import {renderStatus, renderView, startClock} from './views/header';
import {invalidateLibrary, renderLibrary, renderSelection, visibleItems} from './views/library';
import {
  initSettings,
  ipFieldValue,
  openSettings,
  renderSettings,
  runDiscovery,
  saveFtpPort,
  useConsole,
} from './views/settings';
import {toast} from './views/toast';
import {initUninstall, isUninstalling, openUninstall, updateUninstall} from './views/uninstall';

const api = window.api;

function render(): void {
  // One failing section must not freeze the rest of the screen.
  for (const fn of [
    renderStatus,
    renderLibrary,
    renderActivity,
    renderConsole,
    renderView,
    renderDetails,
    updateUninstall,
    renderSettings,
  ]) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

function applyState(state: AppState): void {
  store.state = state;
  if (setLanguage(state.language)) {
    // Text inside the generated tiles and panels changes with the language.
    invalidateLibrary();
    invalidateConsole();
    invalidateActivity();
    invalidateDetails();
  }
  notifyTransitions();
  render();
}

/** Runs an API call, showing its error (if any) as a toast. */
async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    toast(errorText(e), 'error');
    return undefined;
  }
}

async function onAction(el: HTMLElement): Promise<void> {
  const {action} = el.dataset;
  const state = store.state;
  switch (action) {
    case 'openSettings':
      return openSettings();
    case 'addFolders': {
      const added = await run(() => api.addFolders());
      if (added) toast(t('library.foldersAdded', {count: added}), 'success');
      return;
    }
    case 'addFiles': {
      const added = await run(() => api.addFiles());
      if (added) toast(t('library.filesAdded', {count: added}), 'success');
      return;
    }
    case 'rescan':
      return void run(() => api.rescan());
    case 'refreshConsole':
      return void run(() => api.refreshConsole());
    case 'install':
      // Get the panel out of the way so the progress at the top is visible.
      closeDetails();
      if (state && state.ps4 !== 'ready') toast(t('jobs.ps4NotReady'));
      return void run(() => api.install(el.dataset.id!));
    case 'installUpdates': {
      if (state && state.ps4 !== 'ready') toast(t('jobs.ps4NotReady'));
      const queued = await run(() => api.installUpdates());
      if (queued) toast(t('library.updatesQueued', {count: queued}), 'success');
      return;
    }
    case 'toggleSelect': {
      const id = el.dataset.id!;
      if ((el as HTMLInputElement).checked) store.selected.add(id);
      else store.selected.delete(id);
      return renderSelection();
    }
    case 'selectMode':
      store.selecting = (el as HTMLInputElement).checked;
      if (!store.selecting) store.selected.clear();
      return renderSelection();
    case 'selectAll': {
      const visible = visibleItems().filter(i => !i.error);
      store.selecting = true;
      if ((el as HTMLInputElement).checked) for (const i of visible) store.selected.add(i.id);
      else for (const i of visible) store.selected.delete(i.id);
      return renderSelection();
    }
    case 'clearSelection':
      store.selected.clear();
      return renderSelection();
    case 'installSelected': {
      if (state && state.ps4 !== 'ready') toast(t('jobs.ps4NotReady'));
      const queued = await run(() => api.installMany([...store.selected]));
      if (queued === undefined) return;
      store.selected.clear();
      renderSelection();
      toast(t('library.selectedQueued', {count: queued}), queued ? 'success' : '');
      return;
    }
    case 'copyDiagnostics':
      if ((await run(() => api.copyDiagnostics().then(() => true))) === true) {
        toast(t('settings.diagnosticsCopied'), 'success');
      }
      return;
    case 'cancelJob': {
      const job = state?.jobs.find(j => j.id === Number(el.dataset.job));
      const sending = job && job.state !== 'queued';
      const ok = await run(() => api.cancelJob(Number(el.dataset.job)).then(() => true));
      if (ok && sending) toast(t('jobs.cancelledToast', {title: job.title}));
      return;
    }
    case 'clearFinished':
      return void run(() => api.clearFinished());
    case 'removeFromLibrary':
      closeDetails();
      return void run(() => api.removeFromLibrary(el.dataset.id!));
    case 'openUninstall':
      return openUninstall(el.dataset.title!);
    case 'removeFolder':
      return void run(() => api.removeFolder(el.dataset.folder!));
    case 'toggleRecursive':
      return void run(() => api.setFolderRecursive(el.dataset.folder!, (el as HTMLInputElement).checked));
    case 'discover':
      return runDiscovery();
    case 'useConsole':
      return useConsole(el.dataset.ip!);
    case 'saveIp':
      return useConsole(ipFieldValue());
    case 'saveFtpPort':
      return saveFtpPort();
  }
}

/** Closes the panel on top, as Escape does (not while it is deleting a game). */
function closeTopDialog(): void {
  const dialog = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].at(-1);
  if (dialog && !(dialog.id === 'uninstall' && isUninstalling())) dialog.close();
}

/** Adds folders and PKG files dropped on the window. */
async function addDropped(files: FileList): Promise<void> {
  const paths = [...files].map(f => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const added = await run(() => api.addPaths(paths));
  if (!added) return;
  if (added.folders) toast(t('library.foldersAdded', {count: added.folders}), 'success');
  if (added.files) toast(t('library.filesAdded', {count: added.files}), 'success');
  if (!added.folders && !added.files) toast(t('library.alreadyAdded'));
  if (store.view !== 'pc') setView('pc');
}

function bindDrop(): void {
  const overlay = $('#dropOverlay');
  const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  // Counts nested enter/leave pairs: the overlay goes away only when leaving the window.
  let depth = 0;
  document.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  document.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  document.addEventListener('drop', e => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (e.dataTransfer?.files.length) void addDropped(e.dataTransfer.files);
  });
}

/** Checkboxes: handled on "change", never as clicks. */
const CHECKBOX_ACTIONS = new Set(['toggleRecursive', 'toggleSelect', 'selectAll', 'selectMode']);

/** Checks or unchecks a library tile, turning selection mode on if needed. */
function toggleTile(card: HTMLElement): void {
  const box = card.querySelector<HTMLInputElement>('.pick input');
  if (!box || box.disabled) return;
  store.selecting = true;
  box.checked = !box.checked;
  void onAction(box);
}

function setView(view: View): void {
  store.view = view;
  history.replaceState(null, '', view === 'ps4' ? '#ps4' : '#');
  invalidateLibrary();
  invalidateConsole();
  render();
}

function setFilter(filter: Filter): void {
  store.filter = filter;
  for (const chip of $$('.chip')) chip.classList.toggle('active', chip.dataset.kind === filter);
  renderLibrary();
  renderConsole();
}

function bindEvents(): void {
  document.addEventListener('click', e => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action], .chip, .tab[data-view], .card');
    if (!el) return;
    if (el.matches('[data-action]')) {
      // Checkboxes act on "change"; let their click through (and keep a
      // tile's checkbox from opening the tile).
      if (CHECKBOX_ACTIONS.has(el.dataset.action!)) return;
      void onAction(el);
    } else if (el.classList.contains('chip')) setFilter(el.dataset.kind as Filter);
    else if (el.dataset.view) setView(el.dataset.view as View);
    else if (el.classList.contains('card')) {
      // In selection mode a PC tile is checked instead of opened, like a phone gallery.
      if (store.selecting && el.dataset.id) toggleTile(el);
      else openDetails(el.dataset.id ? {id: el.dataset.id} : {titleId: el.dataset.title!});
    }
  });
  document.addEventListener('change', e => {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement && CHECKBOX_ACTIONS.has(el.dataset.action!)) void onAction(el);
  });

  // Side panels and dialogs close on a click outside them (on the backdrop).
  for (const dialog of $$<HTMLDialogElement>('dialog')) {
    dialog.addEventListener('click', e => {
      if (e.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      // The uninstall confirmation stays while it is deleting.
      if (!inside && !(dialog.id === 'uninstall' && isUninstalling())) dialog.close();
    });
  }
  bindDrop();

  // Back to the window: refresh the console list if it is a while old
  // (games may have been installed or deleted on the PS4 meanwhile).
  window.addEventListener('focus', () => {
    const c = store.state?.console;
    if (c && c.state === 'ready' && !c.refreshing && Date.now() - c.updatedAt > 30_000)
      void run(() => api.refreshConsole());
  });

  $<HTMLInputElement>('#search').addEventListener('input', e => {
    store.query = (e.target as HTMLInputElement).value;
    renderLibrary();
    renderConsole();
  });

  // Tiles work like the PS4 library: Enter opens the options, Space checks a PC tile.
  document.addEventListener('keydown', e => {
    const card = (e.target as HTMLElement).closest?.<HTMLElement>('.card');
    if (!card) return;
    if (e.key === 'Enter' || (e.key === ' ' && !card.dataset.id)) {
      e.preventDefault();
      card.click();
    } else if (e.key === ' ') {
      e.preventDefault();
      toggleTile(card);
    }
  });

  initNavigation({
    back: closeTopDialog,
    // Two tabs: either shoulder button goes to the other one.
    switchTab: () => {
      if (!document.querySelector('dialog[open]')) setView(store.view === 'pc' ? 'ps4' : 'pc');
    },
    search: () => {
      if (!document.querySelector('dialog[open]')) $<HTMLInputElement>('#search').focus();
    },
    settings: () => openSettings(),
    select: () => {
      const card = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('#grid .card');
      if (card) toggleTile(card);
    },
    onFirstGamepad: () => toast(t('nav.gamepadConnected')),
  });
}

async function main(): Promise<void> {
  initDetails();
  initUninstall();
  initSettings();
  bindEvents();
  startClock();
  applyState(await api.getState());
  api.onState(applyState);
  // First run: no console yet, so help find it.
  if (!store.state?.config.ps4Ip) openSettings({discover: true});
}

void main();
