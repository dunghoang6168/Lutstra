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

/** Samples the cover at 64 px. */
export async function readTone(src: string): Promise<CoverTone | null> {
  const image = new Image();
  image.src = src;
  try { await image.decode(); } catch { return null; }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0, 64, 64);
  return coverTone(context.getImageData(0, 0, 64, 64).data);
}
