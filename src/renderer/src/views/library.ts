// "On PC" grid: PKGs found in the library folders.
import {$, $$} from '../dom';
import {bytes, esc} from '../format';
import {t} from '../i18n';
import {ICON} from '../icons';
import {requireState, store} from '../store';
import {cover, isActive, jobLabel, kindLabel, latestJob, metaLine, percent} from './common';

let gridKey = '';

function visibleItems() {
  const q = store.query.trim().toLowerCase();
  return requireState().library.filter(
    i =>
      (store.filter === 'all' || i.kind === store.filter) &&
      (!q || [i.title, i.titleId, i.name, i.contentId].some(v => v && v.toLowerCase().includes(q))),
  );
}

/** Forces the next render to rebuild the tiles (e.g. after a language change). */
export const invalidateLibrary = (): void => {
  gridKey = '';
};

export function renderLibrary(): void {
  const state = requireState();
  const items = visibleItems();
  $('#empty').hidden = store.view !== 'pc' || state.library.length > 0 || state.scan.active;
  const key = JSON.stringify([
    store.filter,
    store.query,
    items.map(i => [i.id, i.title, i.installed, i.installedVersion, i.newer, i.error, i.hasIcon]),
  ]);
  if (key === gridKey) return renderTileProgress();
  gridKey = key;
  $('#grid').innerHTML =
    items.length || !state.library.length
      ? items
          .map(
            i => `
    <article class="card" data-id="${i.id}" tabindex="0" title="${esc(i.path)}">
      <div class="tile-art">
        ${cover(i)}
        ${
          i.installed
            ? `<span class="flag" title="${esc(t('library.installedOnPs4'))}">${ICON.check}</span>`
            : i.newer
              ? `<span class="flag newer" title="${esc(t('library.newerThanPs4'))}">${ICON.up}</span>`
              : ''
        }
        <div class="tile-progress"></div>
      </div>
      <h3>${esc(i.title)}</h3>
      <div class="meta">${metaLine([esc(kindLabel(i.kind)), i.version && `v${esc(i.version)}`, bytes(i.size)])}</div>
      ${
        i.error
          ? `<div class="meta state error">${esc(t('library.unreadable'))}</div>`
          : i.installed
            ? `<div class="meta state">${esc(t('library.installed'))}${i.installedVersion ? ` · v${esc(i.installedVersion)}` : ''}</div>`
            : i.newer
              ? `<div class="meta state newer">${esc(t('library.newer', {version: i.installedVersion || ''}))}</div>`
              : ''
      }
    </article>`,
          )
          .join('')
      : `<p class="empty">${esc(t('library.noResults'))}</p>`;
  renderTileProgress(true);
}

/** Progress overlay at the bottom of each tile, like a PS4 download. */
function renderTileProgress(force = false): void {
  for (const card of $$('#grid .card')) {
    const job = latestJob(card.dataset.id!);
    const box = $('.tile-progress', card);
    const active = isActive(job);
    const key = active ? job.state : '';
    if (force || box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = active
        ? `<span></span><div class="progress ${job.state === 'installing' ? '' : 'indeterminate'}"><span></span></div>`
        : '';
    }
    if (active) {
      box.firstElementChild!.textContent = jobLabel(job);
      $('.progress > span', box).style.width = `${percent(job)}%`;
    }
  }
}
