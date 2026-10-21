// Confirmation band for deleting library PKGs from the PC: lists what goes to
// the trash (a file, or a game's whole folder) before doing it.
import type {DeletePlan} from '@shared/types';
import {$} from '../dom';
import {bytes, esc} from '../format';
import {errorText, t} from '../i18n';
import {ICON} from '../icons';
import {store} from '../store';
import {closeDetails} from './details';
import {toast} from './toast';

/** Paths shown in the list; the rest is counted. */
const SHOWN = 8;

let ids: string[] = [];
let busy = false;

const dialog = () => $<HTMLDialogElement>('#deleteFiles');

export const isDeletingFiles = (): boolean => busy;

export async function openDeleteFiles(selection: string[]): Promise<void> {
  let plan: DeletePlan;
  try {
    plan = await window.api.planDelete(selection);
  } catch (e) {
    toast(errorText(e), 'error');
    return;
  }
  if (!plan.targets.length) {
    toast(t(plan.busy ? 'deleteFiles.onlyBusy' : 'deleteFiles.nothing'), plan.busy ? '' : 'error');
    return;
  }
  ids = selection;
  closeDetails();
  const folders = plan.targets.filter(x => x.folder).length;
  const files = plan.targets.length - folders;
  const what = [
    files && t('deleteFiles.files', {count: files}),
    folders && t('deleteFiles.folders', {count: folders}),
  ].filter(Boolean);
  $('#deleteSummary').textContent = t('deleteFiles.summary', {
    what: what.join(t('deleteFiles.and')),
    size: bytes(plan.size),
  });
  $('#deleteList').innerHTML =
    plan.targets
      .slice(0, SHOWN)
      .map(
        x =>
          `<li title="${esc(x.path)}">${x.folder ? ICON.folder : ICON.trash}<span>${esc(x.path)}</span><small>${bytes(x.size)}</small></li>`,
      )
      .join('') +
    (plan.targets.length > SHOWN
      ? `<li class="more">${esc(t('deleteFiles.more', {count: plan.targets.length - SHOWN}))}</li>`
      : '');
  const busyNote = $('#deleteBusy');
  busyNote.hidden = !plan.busy;
  busyNote.textContent = t('deleteFiles.busy', {count: plan.busy});
  render();
  dialog().showModal();
}

function render(): void {
  const button = $<HTMLButtonElement>('#confirmDelete');
  button.disabled = busy;
  button.textContent = t(busy ? 'deleteFiles.deleting' : 'deleteFiles.confirm');
}

export function initDeleteFiles(): void {
  $('#confirmDelete').addEventListener('click', async () => {
    if (busy || !ids.length) return;
    busy = true;
    render();
    try {
      const result = await window.api.deleteFromDisk(ids);
      for (const id of ids) store.selected.delete(id);
      if (result.deleted) toast(t('deleteFiles.done', {count: result.deleted}), 'success');
      if (result.failed.length) toast(t('deleteFiles.failed', {path: result.failed.join(', ')}), 'error');
      dialog().close();
    } catch (e) {
      toast(errorText(e), 'error');
    } finally {
      busy = false;
      render();
    }
  });
}
