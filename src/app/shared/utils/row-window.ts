/** Rows rendered on each side of the viewport, so a fast wheel turn does not show blank space. */
export const ROW_OVERSCAN = 20;

/**
 * The slice of a fixed-height row list to render for a scroll position: [start, end) clamped to the list.
 * `scrollTop` and `viewport` are in the scroller's pixels, measured from the first row.
 */
export function rowWindow(scrollTop: number, viewport: number, rowHeight: number, count: number, overscan = ROW_OVERSCAN): { start: number; end: number } {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: Math.max(0, count) };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const last = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight);
  const start = Math.min(Math.max(0, first - overscan), Math.max(0, count - 1));
  return { start, end: Math.max(start, Math.min(count, last + overscan)) };
}

/** The scrollTop that brings row `index` fully into view with the least movement ('nearest'), or null when it is. */
export function scrollTopToReveal(index: number, scrollTop: number, viewport: number, rowHeight: number): number | null {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return top + rowHeight - viewport;
  return null;
}
