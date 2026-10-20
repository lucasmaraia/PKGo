// Side panel opened from a tile, like the PS4 "Options" menu.
import {$} from '../dom';
import {bytes, duration, esc} from '../format';
import {errorText, t} from '../i18n';
import {ICON} from '../icons';
import {requireState} from '../store';
import {consoleCover, cover, isActive, itemById, jobLabel, kindLabel, latestJob, percent} from './common';

type Target = {id: string} | {titleId: string};

let target: Target | null = null;
let detailKey = '';

const dialog = () => $<HTMLDialogElement>('#details');

export function openDetails(next: Target): void {
  target = next;
  detailKey = '';
  renderDetails();
  if (!target) return;
  dialog().showModal();
  dialog().querySelector<HTMLElement>('.menu-item:not(:disabled)')?.focus();
}

export function closeDetails(): void {
  if (dialog().open) dialog().close();
}

export function initDetails(): void {
  dialog().addEventListener('close', () => {
    target = null;
  });
}

export const invalidateDetails = (): void => {
  detailKey = '';
};

function head(bg: string, coverHtml: string, title: string, sub: string): string {
  return `<div class="d-head">
    ${bg ? `<div class="hero-bg" style="background-image:url(${bg})"></div>` : ''}
    ${coverHtml}<h2>${esc(title)}</h2><p>${esc(sub)}</p></div>`;
}

type InfoRow = [label: string, value: string | number | null | false | undefined, cls?: string];

const infoList = (rows: InfoRow[]) =>
  `<dl class="info">${rows
    .filter(r => r[1])
    .map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd>`)
    .join('')}</dl>`;

const closeItem = () => `<button class="menu-item" value="close">${ICON.close}${esc(t('common.close'))}</button>`;

function renderLibraryItem(id: string, body: HTMLElement): void {
  const item = itemById(id);
  if (!item) {
    target = null;
    return closeDetails();
  }
  const job = latestJob(item.id);
  const active = isActive(job);
  const key = JSON.stringify([item, active && job.state]);
  if (key !== detailKey) {
    detailKey = key;
    const bg = item.hasPic ? `app-media://pic/${item.id}` : item.hasIcon ? `app-media://icon/${item.iconId}` : '';
    const status = item.error
      ? errorText(item.error)
      : item.installed
        ? item.installedVersion
          ? t('details.installed', {version: item.installedVersion})
          : t('library.installedOnPs4')
        : item.newer
          ? t('library.newer', {version: item.installedVersion || ''})
          : item.installed === false
            ? t('details.notInstalled')
            : '';
    const progress = active
      ? `<div class="d-progress"><div class="progress ${job.state === 'installing' ? '' : 'indeterminate'}"><span></span></div><span id="detailsProgress"></span></div>`
      : '';
    const installButton = active
      ? ''
      : `<button type="button" class="menu-item" data-action="install" data-id="${item.id}" ${item.error ? 'disabled' : ''}>${ICON.install}${esc(t(item.installed ? 'details.reinstall' : 'details.install'))}</button>`;
    const cancelButton =
      active && job.state === 'queued'
        ? `<button type="button" class="menu-item" data-action="cancelJob" data-job="${job.id}">${ICON.close}${esc(t('details.removeFromQueue'))}</button>`
        : '';
    body.innerHTML =
      head(bg, cover(item), item.title, `${kindLabel(item.kind)}${item.version ? ` · v${item.version}` : ''}`) +
      progress +
      `<div class="menu">
        ${installButton}
        ${cancelButton}
        <button type="button" class="menu-item" data-action="removeFromLibrary" data-id="${item.id}" ${active ? 'disabled' : ''}>${ICON.trash}${esc(t('details.removeFromLibrary'))}</button>
        ${closeItem()}
      </div>` +
      infoList([
        [t('details.status'), status, item.error ? 'error' : ''],
        ['CUSA', item.titleId],
        ['Content ID', item.contentId],
        [t('details.version'), item.version && `v${item.version}`],
        [t('details.size'), bytes(item.size)],
        [t('details.firmware'), item.firmware],
        [t('details.file'), item.path],
      ]);
  }
  if (active) {
    $('.d-progress .progress > span', body).style.width = `${percent(job)}%`;
    $('#detailsProgress').textContent =
      job.state === 'installing'
        ? [
            `${percent(job).toFixed(1)}%`,
            t('jobs.transferred', {done: bytes(job.transferred), total: bytes(job.total)}),
            job.eta ? t('jobs.eta', {time: duration(job.eta)}) : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : jobLabel(job);
  }
}

function renderConsoleItem(titleId: string, body: HTMLElement): void {
  const item = requireState().console.items.find(i => i.titleId === titleId);
  if (!item) {
    target = null;
    return closeDetails();
  }
  const key = JSON.stringify(item);
  if (key === detailKey) return;
  detailKey = key;
  body.innerHTML =
    head(
      item.hasIcon ? `app-media://console-icon/${item.titleId}` : '',
      consoleCover(item),
      item.title,
      `${kindLabel(item.kind)}${item.version ? ` · v${item.version}` : ''}`,
    ) +
    `<div class="menu">
      <button type="button" class="menu-item" data-action="openUninstall" data-title="${esc(item.titleId)}">${ICON.trash}${esc(t('details.deleteFromPs4'))}</button>
      ${closeItem()}
    </div>` +
    infoList([
      ['CUSA', item.titleId],
      [t(item.kind === 'game' ? 'details.gameVersion' : 'details.version'), item.baseVersion && `v${item.baseVersion}`],
      [t('details.update'), item.patchVersion && `v${item.patchVersion}`],
      [t('details.dlcs'), item.dlcCount || ''],
      [t('details.storage'), t(`storage.${item.storage}`)],
      [t('details.used'), item.size && bytes(item.size)],
    ]);
}

export function renderDetails(): void {
  if (!target) return;
  const body = $('#detailsBody');
  if ('id' in target) renderLibraryItem(target.id, body);
  else renderConsoleItem(target.titleId, body);
}
