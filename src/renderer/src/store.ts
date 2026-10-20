// Renderer state: the latest AppState from the main process plus what is
// only about this screen (tab, filter, search).
import type {AppState, PkgKind} from '@shared/types';

export type View = 'pc' | 'ps4';
export type Filter = 'all' | Exclude<PkgKind, 'other'>;

export const store = {
  state: null as AppState | null,
  view: (location.hash === '#ps4' ? 'ps4' : 'pc') as View,
  filter: 'all' as Filter,
  query: '',
};

export const requireState = (): AppState => {
  if (!store.state) throw new Error('state not loaded');
  return store.state;
};
