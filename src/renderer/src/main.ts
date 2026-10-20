// Renderer entry: receives state from the main process, renders every view
// and turns clicks into API calls.
import type {AppState} from '@shared/types';
import {$, $$} from './dom';
import {errorText, setLanguage, t} from './i18n';
import {store, type Filter, type View} from './store';
import {invalidateActivity, notifyTransitions, renderActivity} from './views/activity';
import {invalidateConsole, renderConsole} from './views/console';
import {closeDetails, initDetails, invalidateDetails, openDetails, renderDetails} from './views/details';
import {renderStatus, renderView, startClock} from './views/header';
import {invalidateLibrary, renderLibrary} from './views/library';
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
import {initUninstall, openUninstall, updateUninstall} from './views/uninstall';

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
    case 'cancelJob':
      return void run(() => api.cancelJob(Number(el.dataset.job)));
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
      // Checkboxes act on "change"; let their click through.
      if (el.dataset.action === 'toggleRecursive') return;
      void onAction(el);
    } else if (el.classList.contains('chip')) setFilter(el.dataset.kind as Filter);
    else if (el.dataset.view) setView(el.dataset.view as View);
    else if (el.classList.contains('card')) {
      openDetails(el.dataset.id ? {id: el.dataset.id} : {titleId: el.dataset.title!});
    }
  });
  document.addEventListener('change', e => {
    const el = e.target as HTMLElement;
    if (el.dataset.action === 'toggleRecursive') void onAction(el);
  });

  $<HTMLInputElement>('#search').addEventListener('input', e => {
    store.query = (e.target as HTMLInputElement).value;
    renderLibrary();
    renderConsole();
  });

  // Tiles work like the PS4 library: arrows move the focus, Enter opens the options.
  document.addEventListener('keydown', e => {
    const card = (e.target as HTMLElement).closest?.<HTMLElement>('.card');
    if (!card) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      card.click();
      return;
    }
    const cards = [...card.parentElement!.querySelectorAll<HTMLElement>('.card')];
    const i = cards.indexOf(card);
    const cols = cards.filter(c => c.offsetTop === cards[0]!.offsetTop).length;
    const next = (
      {ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols} as Record<string, number>
    )[e.key];
    if (next === undefined) return;
    e.preventDefault();
    cards[next]?.focus();
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
