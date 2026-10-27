/** Signed distance from a point (relative to the box centre) to a rounded rectangle's edge; negative inside. */
function roundedBoxDistance(x: number, y: number, halfWidth: number, halfHeight: number, radius: number): number {
  const qx = Math.abs(x) - halfWidth + radius;
  const qy = Math.abs(y) - halfHeight + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

/**
 * RGBA pixels of an feDisplacementMap map for a rounded box: inside a `bezel`-wide band at the rim, red and green
 * push each sample inward along the edge's normal, strongest at the rim ((1 - depth / bezel)²); 128 means no shift.
 * The centre stays neutral, so only the edge bends what lies behind the glass.
 */
export function lensMapPixels(width: number, height: number, radius: number, bezel: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const hw = width / 2, hh = height / 2;
  const r = Math.min(radius, hw, hh);
  const band = Math.max(1, Math.min(bezel, hw, hh));
  const distance = (x: number, y: number) => roundedBoxDistance(x, y, hw, hh, r);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const x = i + 0.5 - hw, y = j + 0.5 - hh;
      const depth = -distance(x, y);
      let dx = 0, dy = 0;
      if (depth > 0 && depth < band) {
        const gx = distance(x + 0.5, y) - distance(x - 0.5, y);
        const gy = distance(x, y + 0.5) - distance(x, y - 0.5);
        const length = Math.hypot(gx, gy) || 1;
        const strength = (1 - depth / band) ** 2;
        dx = (-gx / length) * strength;
        dy = (-gy / length) * strength;
      }
      const k = (j * width + i) * 4;
      pixels[k] = 128 + dx * 127;
      pixels[k + 1] = 128 + dy * 127;
      pixels[k + 2] = 128;
      pixels[k + 3] = 255;
    }
  }
  return pixels;
}
