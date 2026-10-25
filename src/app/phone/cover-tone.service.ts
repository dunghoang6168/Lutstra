import { Injectable, effect, inject, signal } from '@angular/core';
import { PlayerService } from '../core/player/player.service';
import { CoverTone, coverTone } from './cover-tone';

/** The playing track's cover tone, read once per cover and shared by the mini player and Now Playing. */
@Injectable({ providedIn: 'root' })
export class CoverToneService {
  private readonly player = inject(PlayerService);
  /** Null while there is no cover, or it failed to load. */
  readonly tone = signal<CoverTone | null>(null);

  constructor() {
    effect((onCleanup) => {
      const src = this.player.currentTrack()?.artwork;
      if (!src) { this.tone.set(null); return; }
      let stale = false;
      onCleanup(() => { stale = true; });
      void readTone(src).then((tone) => { if (!stale) this.tone.set(tone); });
    });
  }
}

/**
 * Samples the cover at 64 px. The file is decoded and shrunk off the main thread (a Blob to createImageBitmap):
 * drawing the full-size cover on a canvas decoded it there and cost a new track's first frames.
 */
export async function readTone(src: string): Promise<CoverTone | null> {
  let bitmap: ImageBitmap;
  try {
    const blob = await (await fetch(src)).blob();
    bitmap = await createImageBitmap(blob, { resizeWidth: 64, resizeHeight: 64, resizeQuality: 'low' });
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context ? coverTone(context.getImageData(0, 0, 64, 64).data) : null;
}
