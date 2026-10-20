// Install activity above the grid: the current download and the queue/history.
import {ACTIVE_JOB_STATES} from '@shared/types';
import {$} from '../dom';
import {bytes, duration, esc} from '../format';
import {errorText, t} from '../i18n';
import {requireState} from '../store';
import {cover, itemById, percent} from './common';
import {toast} from './toast';

let activityKey = '';

export const invalidateActivity = (): void => {
  activityKey = '';
};

export function renderActivity(): void {
  const {jobs} = requireState();
  const box = $('#activity');
  box.hidden = !jobs.length;
  if (!jobs.length) {
    activityKey = '';
    box.innerHTML = '';
    return;
  }
  const current = jobs.find(j => j.state === 'starting' || j.state === 'installing');
  const others = jobs.filter(j => j !== current).reverse();
  const key = JSON.stringify([current?.id, current?.state, others.map(j => [j.id, j.state])]);
  if (key !== activityKey) {
    activityKey = key;
    const item = current && itemById(current.pkgId);
    const bg = item?.hasPic ? `app-media://pic/${item.id}` : item?.hasIcon ? `app-media://icon/${item.iconId}` : '';
    box.innerHTML =
      (current
        ? `
      <h4>${esc(t('jobs.installing'))}</h4>
      <div class="hero">
        ${bg ? `<div class="hero-bg" style="background-image:url(${bg})"></div>` : ''}
        <div class="hero-body">
          ${cover(item || {title: current.title, hasIcon: false, iconId: null, id: ''})}
          <div class="hero-info">
            <h2>${esc(current.title)}</h2>
            <div class="hero-state" id="heroState"></div>
            <div class="progress" id="heroBar"><span></span></div>
            <div class="hero-stats" id="heroStats"></div>
          </div>
        </div>
      </div>`
        : '') +
      (others.length
        ? `<div class="queue-head"><h4 class="section-label">${esc(t('jobs.history'))}</h4>
        ${others.some(j => !ACTIVE_JOB_STATES.includes(j.state)) ? `<button class="btn small" data-action="clearFinished">${esc(t('jobs.clear'))}</button>` : ''}</div>`
        : '') +
      `<div class="queue">${others
        .map(j => {
          const it = itemById(j.pkgId);
          const sub =
            j.state === 'queued'
              ? t('jobs.waiting')
              : j.state === 'done'
                ? t('jobs.done')
                : j.error
                  ? errorText(j.error)
                  : '';
          return `<div class="queue-row ${j.state}">${cover(it || {title: j.title, hasIcon: false, iconId: null, id: ''})}
          <div class="q-title">${esc(j.title)}<span class="q-sub">${esc(sub)}</span></div>
          ${j.state === 'queued' ? `<button class="btn small" data-action="cancelJob" data-job="${j.id}">${esc(t('jobs.remove'))}</button>` : ''}
          ${j.state === 'error' ? `<button class="btn small" data-action="install" data-id="${j.pkgId}">${esc(t('common.retry'))}</button>` : ''}
        </div>`;
        })
        .join('')}</div>`;
  }
  if (current) {
    const p = percent(current);
    $('#heroState').textContent =
      current.state === 'starting' ? t('jobs.sending') : t('jobs.progress', {percent: p.toFixed(1)});
    $('#heroBar').classList.toggle('indeterminate', current.state === 'starting');
    $('#heroBar > span').style.width = `${p}%`;
    $('#heroStats').innerHTML =
      current.state === 'installing'
        ? [
            `<span>${esc(t('jobs.transferred', {done: bytes(current.transferred), total: bytes(current.total)}))}</span>`,
            current.speed ? `<span><strong>${bytes(current.speed)}/s</strong></span>` : '',
            current.eta ? `<span>${esc(t('jobs.eta', {time: duration(current.eta)}))}</span>` : '',
          ].join('')
        : `<span>${esc(t('jobs.waitingPs4'))}</span>`;
  }
}

let lastStates = new Map<number, string>();

/** Toasts when a job finishes or fails. */
export function notifyTransitions(): void {
  const next = new Map<number, string>();
  for (const j of requireState().jobs) {
    const before = lastStates.get(j.id);
    if (before && before !== j.state) {
      if (j.state === 'done') toast(t('jobs.doneToast', {title: j.title}), 'success');
      if (j.state === 'error' && j.error) toast(`${j.title}: ${errorText(j.error)}`, 'error');
    }
    next.set(j.id, j.state);
  }
  lastStates = next;
}
