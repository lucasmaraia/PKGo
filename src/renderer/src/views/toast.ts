import {$} from '../dom';

export function toast(message: string, type: '' | 'error' | 'success' = ''): void {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 5000);
}
