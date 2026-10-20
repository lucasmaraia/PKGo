// Top bar (console status, clock) and the tab/filter chrome around the grids.
import {$, $$} from '../dom';
import {bytes} from '../format';
import {currentLanguage, t} from '../i18n';
import {requireState, store} from '../store';

export function renderStatus(): void {
  const {ps4, config} = requireState();
  const pill = $('#ps4Status');
  pill.className = `status ${ps4}`;
  $('.label', pill).textContent = t(`status.${ps4}`, {ip: config.ps4Ip});
}

export function renderView(): void {
  const state = requireState();
  const {view} = store;
  for (const tab of $$('.tab[data-view]')) tab.classList.toggle('active', tab.dataset.view === view);
  for (const el of $$('[data-for]')) el.hidden = el.dataset.for !== view;
  $('#grid').hidden = view !== 'pc';
  $('#viewTitle').textContent = t(view === 'pc' ? 'nav.pc' : 'nav.ps4');
  $('#countPc').textContent = state.library.length ? String(state.library.length) : '';
  const c = state.console;
  $('#countPs4').textContent = c.state === 'ready' ? String(c.items.length) : '';
  const list = view === 'pc' ? state.library : c.items;
  const total = list.reduce((sum, i) => sum + (i.size || 0), 0);
  const games = list.filter(i => i.kind === 'game').length;
  let summary = list.length ? t('summary', {games, others: list.length - games, size: bytes(total)}) : '';
  if (view === 'ps4' && c.refreshing && c.state === 'ready') summary += ` · ${t('console.updating')}`;
  if (view === 'pc' && state.scan.active)
    summary = t('library.scanning', {folders: state.scan.folders, found: state.scan.found});
  $('#summary').textContent = summary;
}

export function startClock(): void {
  const tick = () => {
    $('#clock').textContent = new Date().toLocaleTimeString(currentLanguage(), {hour: '2-digit', minute: '2-digit'});
  };
  tick();
  setInterval(tick, 5000);
}
