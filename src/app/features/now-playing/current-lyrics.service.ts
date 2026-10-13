import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { LYRICS_GATEWAY } from '../../core/contracts';
import { LyricLine } from '../../core/models';
import { PlayerService } from '../../core/player/player.service';
import { activeLyricIndex, parseLrc } from './lrc-parser';

export type LyricsStatus = 'loading' | 'ready' | 'missing' | 'unsupported' | 'error';

/** Timed lyrics of the current track, loaded once and shared by Now Playing and Gallery's rail. */
@Injectable({ providedIn: 'root' })
export class CurrentLyricsService {
  private readonly player = inject(PlayerService);
  private readonly gateway = inject(LYRICS_GATEWAY);
  readonly status = signal<LyricsStatus>('missing');
  readonly lines = signal<LyricLine[]>([]);
  readonly activeLineIndex = computed(() => activeLyricIndex(this.lines(), this.player.currentTime()));
  private request = 0;
  private lastTrackKey: string | null = null;

  constructor() {
    effect(() => {
      const trackId = this.player.currentTrack()?.id ?? null;
      const queueEntry = this.player.currentQueueEntry();
      const trackKey = trackId ? `${trackId}:${queueEntry?.track.id === trackId ? queueEntry.id : ''}` : null;
      if (trackKey === this.lastTrackKey) return;
      this.lastTrackKey = trackKey;
      const request = ++this.request;
      this.lines.set([]);
      if (!trackId) { this.status.set('missing'); return; }
      this.status.set('loading');
      void this.gateway.getLyrics(trackId).then((contents) => {
        if (request !== this.request) return;
        if (contents === null) { this.status.set('missing'); return; }
        const lines = parseLrc(contents);
        this.lines.set(lines);
        this.status.set(lines.length ? 'ready' : 'unsupported');
      }).catch(() => {
        if (request === this.request) this.status.set('error');
      });
    });
  }

  seek(line: LyricLine): void { this.player.seek(line.time); }
}

/** Scrolls a lyrics viewport so line `index` sits in the middle (top when no line is active yet). */
export function centerLyricLine(viewport: HTMLElement, index: number): void {
  if (index < 0) { viewport.scrollTo({ top: 0, behavior: 'instant' }); return; }
  const line = viewport.querySelector<HTMLElement>(`[data-lyric-index="${index}"]`);
  if (!line) return;
  const top = viewport.scrollTop + line.getBoundingClientRect().top
    - viewport.getBoundingClientRect().top + line.offsetHeight / 2 - viewport.clientHeight / 2;
  const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  viewport.scrollTo({ top: Math.max(0, top), behavior });
}
