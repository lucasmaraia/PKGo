// Geometry of arrow-key and D-pad navigation (see renderer/src/navigation.ts),
// kept free of the DOM so it can be tested.
export type Direction = 'left' | 'right' | 'up' | 'down';

/** The parts of a DOMRect it needs. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Index of the box nearest to `from` in a direction, or -1: it has to start
 * past the current one's edge, and being out of line costs more than being far.
 */
export function nearest(from: Box, boxes: Box[], direction: Direction): number {
  let best = -1;
  let bestScore = Infinity;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  const horizontal = direction === 'left' || direction === 'right';
  boxes.forEach((r, i) => {
    const gap = {
      right: r.left - from.right,
      left: from.left - r.right,
      down: r.top - from.bottom,
      up: from.top - r.bottom,
    }[direction];
    if (gap < -4) return;
    // Distance across the movement; while the two overlap on that axis, a
    // small part of the distance between centers breaks ties.
    const across = horizontal
      ? Math.max(0, r.top - from.bottom, from.top - r.bottom) || Math.abs(r.top + r.height / 2 - cy) / 4
      : Math.max(0, r.left - from.right, from.left - r.right) || Math.abs(r.left + r.width / 2 - cx) / 4;
    const score = Math.max(0, gap) + across * 3;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}
