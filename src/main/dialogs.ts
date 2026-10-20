// Native pickers attached to the app window, so they always open in front of it.
import {dialog, type BrowserWindow, type OpenDialogOptions} from 'electron';
import {translate} from '@shared/i18n';
import type {Language} from '@shared/types';

async function open(win: BrowserWindow | undefined, options: OpenDialogOptions): Promise<string[]> {
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

export const pickFolders = (win: BrowserWindow | undefined, language: Language) =>
  open(win, {
    title: translate(language, 'dialogs.pickFolders'),
    properties: ['openDirectory', 'multiSelections'],
  });

export const pickFiles = (win: BrowserWindow | undefined, language: Language) =>
  open(win, {
    title: translate(language, 'dialogs.pickFiles'),
    properties: ['openFile', 'multiSelections'],
    filters: [{name: translate(language, 'dialogs.pkgFilter'), extensions: ['pkg']}],
  });
