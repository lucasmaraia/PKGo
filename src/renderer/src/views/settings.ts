// Settings panel: console address (with network discovery), library folders,
// language and about.
import {LANGUAGE_NAMES} from '@shared/i18n';
import {LANGUAGES, type DiscoveredConsole, type Language} from '@shared/types';
import {$} from '../dom';
import {esc} from '../format';
import {errorText, t} from '../i18n';
import {ICON} from '../icons';
import {requireState, store} from '../store';
import {toast} from './toast';

const dialog = () => $<HTMLDialogElement>('#settings');
const form = () => $<HTMLFormElement>('#settingsForm');
const field = (name: string) => form().elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;

let discovered: DiscoveredConsole[] | null = null;
let discovering = false;
let foldersKey = '';

export function openSettings({discover = false} = {}): void {
  const state = requireState();
  field('ps4Ip').value = state.config.ps4Ip;
  field('ftpPort').value = String(state.config.ftpPort);
  field('language').value = state.config.language || 'auto';
  foldersKey = '';
  renderSettings();
  if (!dialog().open) dialog().showModal();
  if (discover) void runDiscovery();
}

/** Rebuilds the parts of the panel that depend on state or language. */
export function renderSettings(): void {
  if (!store.state) return;
  const state = store.state;
  const select = $<HTMLSelectElement>('#languageSelect');
  const current = select.value || state.config.language || 'auto';
  select.innerHTML =
    `<option value="auto">${esc(t('settings.languageAuto'))}</option>` +
    LANGUAGES.map(l => `<option value="${l}">${esc(LANGUAGE_NAMES[l])}</option>`).join('');
  select.value = current;

  const folders = state.config.folders;
  const key = JSON.stringify([folders, state.scan.missing, state.language]);
  if (key !== foldersKey) {
    foldersKey = key;
    $('#folderList').innerHTML = folders.length
      ? folders
          .map(
            f => `<li>
        ${ICON.folder}
        <div class="folder-path"><span title="${esc(f.path)}">${esc(f.path)}</span>
          ${state.scan.missing.includes(f.path) ? `<em class="missing">${esc(t('settings.folderMissing'))}</em>` : ''}</div>
        <label class="toggle"><input type="checkbox" data-action="toggleRecursive" data-folder="${esc(f.path)}" ${f.recursive ? 'checked' : ''}>${esc(t('settings.subfolders'))}</label>
        <button type="button" class="btn small" data-action="removeFolder" data-folder="${esc(f.path)}">${esc(t('common.remove'))}</button>
      </li>`,
          )
          .join('')
      : `<li class="none">${esc(t('settings.noFolders'))}</li>`;
  }
  $('#scanInfo').textContent = state.scan.active
    ? t('library.scanning', {folders: state.scan.folders, found: state.scan.found})
    : t('settings.libraryCount', {count: state.library.length});
  $('#lanInfo').textContent = t('settings.lanInfo', {ip: state.lanIp || '—'});
  $('#aboutText').innerHTML = esc(t('settings.aboutText', {version: window.api.version})).replace(
    'GitHub',
    '<a href="https://github.com/lucasmaraia/pkg-sender" target="_blank" rel="noreferrer">GitHub</a>',
  );
  renderDiscovered();
}

function renderDiscovered(): void {
  const list = $('#discovered');
  const button = $<HTMLButtonElement>('#discoverBtn');
  button.disabled = discovering;
  $('span', button).textContent = t(discovering ? 'settings.discovering' : 'settings.discover');
  if (discovered === null) {
    list.innerHTML = '';
    return;
  }
  const current = store.state?.config.ps4Ip;
  list.innerHTML = discovered.length
    ? discovered
        .map(c => {
          const state = c.status ? t(c.status === 'on' ? 'settings.on' : 'settings.standby') : '';
          return `<li>
        <div class="grow"><strong>${esc(c.name || 'PS4')}</strong><small>${esc([c.ip, state].filter(Boolean).join(' · '))}</small></div>
        <span class="tag ${c.goldhen ? '' : 'off'}">${esc(t(c.goldhen ? 'settings.goldhenOn' : 'settings.goldhenOff'))}</span>
        <button type="button" class="btn small" data-action="useConsole" data-ip="${esc(c.ip)}" ${c.ip === current ? 'disabled' : ''}>${esc(t(c.ip === current ? 'settings.inUse' : 'settings.use'))}</button>
      </li>`;
        })
        .join('')
    : `<li class="none">${esc(t('settings.noneFound'))}</li>`;
}

export async function runDiscovery(): Promise<void> {
  if (discovering) return;
  discovering = true;
  renderDiscovered();
  try {
    discovered = await window.api.discover();
    // A single console with GoldHEN and no IP set yet: just use it.
    const only = discovered.length === 1 ? discovered[0] : undefined;
    if (only?.goldhen && !requireState().config.ps4Ip) await useConsole(only.ip);
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    discovering = false;
    renderDiscovered();
  }
}

export async function useConsole(ip: string): Promise<void> {
  try {
    await window.api.setConfig({ps4Ip: ip});
    field('ps4Ip').value = ip;
    toast(t('settings.saved'), 'success');
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export async function saveFtpPort(): Promise<void> {
  try {
    await window.api.setConfig({ftpPort: Number(field('ftpPort').value)});
    toast(t('settings.saved'), 'success');
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

export function initSettings(onLanguage: (language: Language | null) => void): void {
  $<HTMLSelectElement>('#languageSelect').addEventListener('change', async e => {
    const value = (e.target as HTMLSelectElement).value;
    const language = value === 'auto' ? null : (value as Language);
    try {
      await window.api.setConfig({language});
      onLanguage(language);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
  // Enter in the IP field saves it instead of closing the dialog.
  field('ps4Ip').addEventListener('keydown', e => {
    if ((e as KeyboardEvent).key === 'Enter') {
      e.preventDefault();
      void useConsole(field('ps4Ip').value.trim());
    }
  });
}

export const ipFieldValue = (): string => field('ps4Ip').value.trim();
