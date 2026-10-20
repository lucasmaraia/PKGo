// Inline SVG icons (stroke style, 24×24).
const svg = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;

export const ICON = {
  check: svg('<path d="m5 12 5 5 9-10"/>'),
  up: svg('<path d="M12 19V5m0 0-6 6m6-6 6 6"/>'),
  install: svg('<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>'),
  trash: svg('<path d="M5 7h14M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3"/>'),
  close: svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  folder: svg('<path d="M3 7h6l2 2h10v10H3z"/>'),
};
