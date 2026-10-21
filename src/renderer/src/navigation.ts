// Keyboard and game controller navigation, like on the PS4: arrows or the
// D-pad move the focus to the nearest control in that direction, Enter or
// Cross activates it, Escape or Circle goes back, L1/R1 switch tabs.
import {nearest, type Direction} from '@shared/spatial';

export interface NavigationActions {
  /** Circle: close the open panel. */
  back(): void;
  /** L1 / R1. */
  switchTab(step: -1 | 1): void;
  /** Triangle. */
  search(): void;
  /** Options. */
  settings(): void;
  /** The first controller of the session connected (to explain the buttons once). */
  onFirstGamepad(): void;
}

const FOCUSABLE = [
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'summary',
  'a[href]',
  '[tabindex="0"]',
].join(',');

/** Controls inside the open dialog, or on the page when none is open. */
function candidates(): HTMLElement[] {
  const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')];
  const scope: ParentNode = dialogs.at(-1) ?? document;
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => {
    if (!dialogs.length && el.closest('dialog')) return false;
    // Hidden ones (and those in closed <details>) take no space.
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
}

export function moveFocus(direction: Direction): void {
  const list = candidates();
  if (!list.length) return;
  const current = document.activeElement as HTMLElement | null;
  if (!current || current === document.body || !list.includes(current)) {
    // Start on the first tile when there is one, like the PS4 home screen.
    const first = list.find(el => el.classList.contains('card')) ?? list[0]!;
    return focus(first);
  }
  const others = list.filter(el => el !== current);
  const i = nearest(
    current.getBoundingClientRect(),
    others.map(el => el.getBoundingClientRect()),
    direction,
  );
  if (i >= 0) focus(others[i]!);
}

function focus(el: HTMLElement): void {
  // Show the focus ring even when the last input was a mouse click.
  document.body.classList.add('pad');
  el.focus();
  el.scrollIntoView({block: 'nearest', inline: 'nearest'});
}

const ARROWS: Record<string, Direction> = {ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'};

/** Arrow keys inside these keep their own meaning (caret, options). */
function ownsArrows(el: Element | null, key: string): boolean {
  if (el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(el.type)) {
    return key === 'ArrowLeft' || key === 'ArrowRight' || el.type === 'number';
  }
  return el instanceof HTMLTextAreaElement;
}

// Standard gamepad mapping (DualShock 4 / DualSense / Xbox).
const BUTTON = {cross: 0, circle: 1, triangle: 3, l1: 4, r1: 5, options: 9, up: 12, down: 13, left: 14, right: 15};
const REPEAT_DELAY = 350;
const REPEAT_RATE = 120;
const STICK = 0.5;

export function initNavigation(actions: NavigationActions): void {
  document.addEventListener('keydown', e => {
    const direction = ARROWS[e.key];
    if (!direction || e.altKey || e.ctrlKey || e.metaKey || ownsArrows(document.activeElement, e.key)) return;
    e.preventDefault();
    moveFocus(direction);
  });
  document.addEventListener('mousedown', () => document.body.classList.remove('pad'));

  // Buttons held down: direction repeats, the others fire once per press.
  const held = new Map<string, number>();
  let frame = 0;

  const press = (name: string, now: number, down: boolean, fire: () => void, repeat = false) => {
    if (!down) return void held.delete(name);
    const since = held.get(name);
    if (since === undefined) {
      held.set(name, now);
      fire();
    } else if (repeat && now - since > REPEAT_DELAY) {
      held.set(name, now - REPEAT_DELAY + REPEAT_RATE);
      fire();
    }
  };

  const poll = (now: number) => {
    const pads = navigator.getGamepads().filter(p => p !== null);
    if (!pads.length) {
      frame = 0;
      // A button held while the controller dropped is not still held when it comes back.
      held.clear();
      return;
    }
    frame = requestAnimationFrame(poll);
    if (!document.hasFocus()) return;
    for (const pad of pads) {
      const b = (i: number) => !!pad.buttons[i]?.pressed;
      const [x = 0, y = 0] = pad.axes;
      const id = `${pad.index}:`;
      press(id + 'up', now, b(BUTTON.up) || y < -STICK, () => moveFocus('up'), true);
      press(id + 'down', now, b(BUTTON.down) || y > STICK, () => moveFocus('down'), true);
      press(id + 'left', now, b(BUTTON.left) || x < -STICK, () => moveFocus('left'), true);
      press(id + 'right', now, b(BUTTON.right) || x > STICK, () => moveFocus('right'), true);
      press(id + 'cross', now, b(BUTTON.cross), () => {
        const el = document.activeElement as HTMLElement | null;
        if (el && el !== document.body) el.click();
        else moveFocus('down');
      });
      press(id + 'circle', now, b(BUTTON.circle), actions.back);
      press(id + 'triangle', now, b(BUTTON.triangle), actions.search);
      press(id + 'l1', now, b(BUTTON.l1), () => actions.switchTab(-1));
      press(id + 'r1', now, b(BUTTON.r1), () => actions.switchTab(1));
      press(id + 'options', now, b(BUTTON.options), actions.settings);
    }
  };

  // Controllers often drop and come back on their own (Bluetooth, Steam or
  // DS4Windows remapping), so only the first connection is announced.
  let announced = false;
  window.addEventListener('gamepadconnected', () => {
    if (!announced) {
      announced = true;
      actions.onFirstGamepad();
    }
    if (!frame) frame = requestAnimationFrame(poll);
  });
}
