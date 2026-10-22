/** What the scrollbar needs from its scroller. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** How far the scroller has gone, 0 at the top and 1 at the bottom; 0 when it cannot scroll. */
export function scrollFraction({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): number {
  const max = scrollHeight - clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, scrollTop / max)) : 0;
}

/** Top of the thumb in a track `trackHeight` tall. */
export function thumbTop(metrics: ScrollMetrics, trackHeight: number, thumbHeight: number): number {
  return scrollFraction(metrics) * Math.max(0, trackHeight - thumbHeight);
}

/** The scrollTop that puts the thumb's top at `top`, clamped to the track. */
export function scrollTopForThumb(top: number, metrics: ScrollMetrics, trackHeight: number, thumbHeight: number): number {
  const room = trackHeight - thumbHeight;
  const fraction = room > 0 ? Math.min(1, Math.max(0, top / room)) : 0;
  return fraction * Math.max(0, metrics.scrollHeight - metrics.clientHeight);
}
