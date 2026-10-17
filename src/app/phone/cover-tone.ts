/** The hue and chroma (OKLCH) Now Playing tints its controls with; chroma 0 means the cover is neutral and so are they. */
export interface CoverTone {
  hue: number;
  chroma: number;
}

/** Below this share of colourful pixels, or this mean chroma, a cover reads as grey (after PixelPlayer's neutral artwork check). */
const MIN_COLOURFUL_SHARE = 0.1;
const MIN_CHROMA = 0.04;
const HUE_BINS = 36;

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** sRGB to OKLCH lightness, chroma and hue (degrees). */
export function toOklch(r: number, g: number, b: number): [number, number, number] {
  const lr = linear(r), lg = linear(g), lb = linear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), (Math.atan2(B, A) * 180 / Math.PI + 360) % 360];
}

/**
 * Picks a cover's seed from RGBA pixels: colourful pixels (not near black or white) vote into hue bins by their
 * chroma, and the strongest bin's mean hue and chroma win. A cover that is mostly grey gives chroma 0.
 * ponytail: hue bins stand in for Material's QuantizerCelebi + Score; port those if seeds look off on real covers.
 */
export function coverTone(pixels: Uint8ClampedArray): CoverTone {
  const bins = Array.from({ length: HUE_BINS }, () => ({ weight: 0, hue: 0, chroma: 0, count: 0 }));
  let colourful = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const [lightness, chroma, hue] = toOklch(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (chroma < MIN_CHROMA || lightness < 0.15 || lightness > 0.95) continue;
    colourful++;
    const bin = bins[Math.floor(hue / (360 / HUE_BINS)) % HUE_BINS];
    bin.weight += chroma;
    bin.hue += hue;
    bin.chroma += chroma;
    bin.count++;
  }
  const best = bins.reduce((a, b) => (b.weight > a.weight ? b : a));
  if (!best.count) return { hue: 0, chroma: 0 };
  const hue = Math.round(best.hue / best.count);
  const chroma = best.chroma / best.count;
  const neutral = colourful / (pixels.length / 4) < MIN_COLOURFUL_SHARE || chroma < MIN_CHROMA;
  return { hue, chroma: neutral ? 0 : Math.round(chroma * 1000) / 1000 };
}
