// "On PS4" grid: what is installed on the console, read over the GoldHEN FTP.
import {$} from '../dom';
import {bytes, esc} from '../format';
import {errorText, t} from '../i18n';
import {requireState, store} from '../store';
import {consoleCover, kindLabel, metaLine} from './common';

let consoleKey = '';

export const invalidateConsole = (): void => {
  consoleKey = '';
};

function visibleItems() {
  const q = store.query.trim().toLowerCase();
  const {filter} = store;
  return requireState().console.items.filter(
    i =>
      (filter === 'all' ||
        i.kind === filter ||
        (filter === 'patch' && i.patchVersion) ||
        (filter === 'dlc' && i.dlcCount)) &&
      (!q || [i.title, i.titleId].some(v => v && v.toLowerCase().includes(q))),
  );
}

function statusHtml(): string {
  const state = requireState();
  const c = state.console;
  if (!state.config.ps4Ip) {
    return `<h2>${esc(t('console.notConfigured'))}</h2><p>${esc(t('console.notConfiguredHint'))}</p>
      <button class="btn" data-action="openSettings">${esc(t('nav.settings'))}</button>`;
  }
  if (c.state === 'loading' || c.state === 'idle') {
    const p = c.total ? (c.done / c.total) * 100 : 0;
    return `<div class="spinner"></div><h2>${esc(t('console.loading'))}</h2>
      <p>${esc(c.total ? t('console.progress', {done: c.done, total: c.total}) : t('console.connecting'))}</p>
      <div class="progress loading-bar ${c.total ? '' : 'indeterminate'}"><span style="width:${p}%"></span></div>`;
  }
  if (c.state === 'error') {
    return `<h2>${esc(t('console.readFailed'))}</h2><p>${esc(c.error ? errorText(c.error) : '')}</p>
      <button class="btn" data-action="refreshConsole">${esc(t('common.retry'))}</button>`;
  }
  return '';
}

export function renderConsole(): void {
  const c = requireState().console;
  const grid = $('#consoleGrid');
  const status = $('#consoleStatus');
  const html = statusHtml();
  status.hidden = store.view !== 'ps4' || !html;
  if (html && status.dataset.html !== html) {
    status.innerHTML = html;
    status.dataset.html = html;
  }
  grid.hidden = store.view !== 'ps4' || !!html;
  if (html) return;
  const items = visibleItems();
  const key = JSON.stringify([store.filter, store.query, c.updatedAt, items.map(i => [i.titleId, i.title])]);
  if (key === consoleKey) return;
  consoleKey = key;
  grid.innerHTML = items.length
    ? items
        .map(i => {
          const extras = metaLine([
            i.patchVersion && t('console.withUpdate'),
            i.dlcCount && t('console.dlcCount', {count: i.dlcCount}),
          ]);
          return `
    <article class="card" data-title="${esc(i.titleId)}" tabindex="0" title="${esc(i.titleId)}">
      <div class="tile-art">${consoleCover(i)}</div>
      <h3>${esc(i.title)}</h3>
      <div class="meta">${metaLine([esc(kindLabel(i.kind)), i.version && `v${esc(i.version)}`, i.size && bytes(i.size)])}</div>
      ${extras ? `<div class="meta state">${esc(extras)}</div>` : ''}
    </article>`;
        })
        .join('')
    : `<p class="empty">${esc(t('library.noResults'))}</p>`;
}
