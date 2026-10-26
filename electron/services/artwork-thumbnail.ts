import { nativeImage } from 'electron';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Longest side of a list cover: sharp for a 36px row cover and a playlist card's 2x2 cell on a 1.5x screen. */
export const SMALL_ARTWORK_SIZE = 192;
const pending = new Map<string, Promise<string | null>>();

/**
 * A small JPEG copy of a cached cover for lists, made on first request and kept in `<cacheDir>/small`.
 * Null when the source cannot be read as an image (nativeImage reads JPEG and PNG); callers then serve the original.
 * ponytail: nativeImage decodes on the main thread; lists ask only for covers in view, so it stays a few ms each.
 * Move it to a utility process if first opens of large libraries stall.
 */
export function smallArtwork(cacheDir: string, hash: string, sourcePath: string): Promise<string | null> {
  const running = pending.get(hash);
  if (running) return running;
  const job = makeSmall(path.join(cacheDir, 'small', `${hash}.jpg`), sourcePath).finally(() => pending.delete(hash));
  pending.set(hash, job);
  return job;
}

async function makeSmall(target: string, sourcePath: string): Promise<string | null> {
  try { await access(target); return target; } catch { /* not made yet */ }
  const image = nativeImage.createFromBuffer(await readFile(sourcePath));
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (Math.max(width, height) <= SMALL_ARTWORK_SIZE) return sourcePath;
  const small = width >= height
    ? image.resize({ width: SMALL_ARTWORK_SIZE, quality: 'good' })
    : image.resize({ height: SMALL_ARTWORK_SIZE, quality: 'good' });
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, small.toJPEG(85));
  return target;
}
