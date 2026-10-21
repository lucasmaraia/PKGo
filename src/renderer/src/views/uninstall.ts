// Confirmation band for deleting a game (or only its update) from the PS4.
import {$} from '../dom';
import {bytes, esc} from '../format';
import {errorText, t} from '../i18n';
import {requireState, store} from '../store';
import {consoleCover} from './common';
import {closeDetails} from './details';
import {toast} from './toast';

let targetId: string | null = null;
let busy = false;

export const isUninstalling = (): boolean => busy;

const dialog = () => $<HTMLDialogElement>('#uninstall');

export function openUninstall(titleId: string): void {
  const item = requireState().console.items.find(i => i.titleId === titleId);
  if (!item) return;
  targetId = titleId;
  closeDetails();
  const details = [item.titleId, item.version && `v${item.version}`, bytes(item.size)].filter(Boolean).join(' · ');
  $('#uninstallItem').innerHTML = `${consoleCover(item)}<div><strong>${esc(item.title)}</strong>
    <span>${esc(details)}</span></div>`;
  const patchChoice = item.patchVersion
    ? `<label class="choice"><input type="radio" name="what" value="patch">
      <span><strong>${esc(t('uninstall.patch', {version: item.patchVersion}))}</strong><small>${esc(t('uninstall.patchHint', {version: item.baseVersion || '01.00'}))}</small></span></label>`
    : '';
  $('#uninstallChoices').innerHTML = `
    <label class="choice"><input type="radio" name="what" value="game" checked>
      <span><strong>${esc(t('uninstall.game'))}</strong><small>${esc(t('uninstall.gameHint', {size: bytes(item.size)}))}</small></span></label>
    ${patchChoice}`;
  updateUninstall();
  dialog().showModal();
}

export function updateUninstall(): void {
  const state = store.state;
  const unavailable = state?.ps4 !== 'ready' || !state.payloads.tools;
  $('#uninstallOffline').hidden = !unavailable;
  const btn = $<HTMLButtonElement>('#confirmUninstall');
  btn.disabled = unavailable || busy;
  btn.textContent = t(busy ? 'uninstall.deleting' : 'uninstall.confirm');
}

export function initUninstall(): void {
  dialog().addEventListener('close', () => {
    if (!busy) targetId = null;
  });
  $('#confirmUninstall').addEventListener('click', async () => {
    if (!targetId || busy) return;
    const titleId = targetId;
    const item = requireState().console.items.find(i => i.titleId === titleId);
    const checked = $<HTMLFormElement>('#uninstallForm').querySelector<HTMLInputElement>('input[name=what]:checked');
    const what = checked?.value === 'patch' ? 'patch' : 'game';
    busy = true;
    updateUninstall();
    try {
      await window.api.uninstall(titleId, what);
      toast(
        t(what === 'patch' ? 'uninstall.patchDone' : 'uninstall.gameDone', {title: item?.title || titleId}),
        'success',
      );
      dialog().close();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      busy = false;
      updateUninstall();
    }
  });
}
