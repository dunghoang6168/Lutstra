import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { SYSTEM_DEFAULT_OUTPUT_ID, Track } from '../../core/models';
import { PlayerService } from '../../core/player/player.service';
import { RandomSessionService } from './random-session.service';
import type { RarityTier } from './random-folder.utils';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { SpectrumVisualizerComponent } from '../../shared/components/spectrum-visualizer/spectrum-visualizer.component';

// Fast start, long slow crawl into the winner, like a case opening.
const SPIN_EASING = 'cubic-bezier(0.08, 0.6, 0.12, 1)';
/** Peak gain of the reel sounds at full player volume. */
const SOUND_LEVEL = 0.25;

/** Case-opening reel: the strip spins once and stops on `items[winnerIndex]`, then emits `done`. */
@Component({
  selector: 'app-random-reel',
  standalone: true,
  imports: [IconComponent, SpectrumVisualizerComponent],
  templateUrl: './random-reel.component.html',
  styleUrl: './random-reel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RandomReelComponent {
  readonly items = input.required<Track[]>();
  readonly winnerIndex = input.required<number>();
  /** Stop point inside the winning cell, in cell widths from its centre. */
  readonly offset = input(0);
  /** Redraw an earlier roll at its stop point: no spin, no sound, no `done`. */
  readonly settled = input(false);
  readonly durationMs = input(7000);
  readonly done = output<void>();

  readonly spinning = signal(true);
  readonly rarity = inject(RandomSessionService).tierOf;
  readonly winTier = computed(() => {
    const winner = this.items()[this.winnerIndex()];
    return winner ? this.rarity(winner) : 1;
  });
  private readonly player = inject(PlayerService);
  /** Spectrum bars take the rarity colour of the track playing. */
  readonly spectrumColor = computed(() => {
    const track = this.player.currentTrack();
    // Mythical follows the page's hologram clock, re-read every frame (liveColor).
    const tier = track ? this.rarity(track) : 1;
    return tier === 5 ? '--holo-live' : `--rarity-${tier}`;
  });
  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');
  private readonly strip = viewChild.required<ElementRef<HTMLElement>>('strip');
  private animation: Animation | null = null;
  // ponytail: sounds play through Chromium on the player's output (matched by name for the native
  // engine), not through the playback engine, so they stay silent while an exclusive output holds the DAC.
  private audio: AudioContext | null = null;
  private frame = 0;
  private stripEl: HTMLElement | null = null;
  private stopX = 0;

  constructor() {
    // A hidden window freezes the reel; finish it at once so the pick plays instead of waiting.
    const skipWhenHidden = () => { if (document.hidden) this.skip(); };
    // The session settled this spin on its own (its safety net fired): stop the strip on the pick.
    effect(() => { if (this.settled() && untracked(this.spinning)) this.skip(); });
    document.addEventListener('visibilitychange', skipWhenHidden);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', skipWhenHidden);
      this.animation?.cancel();
      cancelAnimationFrame(this.frame);
      void this.audio?.close();
    });
    afterNextRender(() => {
      const strip = this.strip().nativeElement;
      const cells = strip.children;
      const winner = cells[this.winnerIndex()] as HTMLElement | undefined;
      if (!winner) return this.finish();
      // The strip starts at the pointer (margin-left: 50%), so the stop point does not depend on the
      // viewport width, which changes when playback opens Gallery's now-playing rail.
      const start = this.viewport().nativeElement.clientWidth / 2;
      const origin = strip.getBoundingClientRect().left;
      const cell = winner.getBoundingClientRect();
      const target = cell.left - origin + cell.width * (0.5 + this.offset());
      this.stripEl = strip;
      this.stopX = Math.round(-target);
      const pitch = cells.length > 1 ? cells[1].getBoundingClientRect().left - cells[0].getBoundingClientRect().left : cell.width;
      if (this.settled()) {
        strip.style.transform = `translateX(${this.stopX}px)`;
        this.spinning.set(false);
        return;
      }
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.animation = strip.animate(
        [{ transform: `translateX(${-start}px)` }, { transform: `translateX(${-target}px)` }],
        { duration: reduced ? 0 : this.durationMs(), easing: SPIN_EASING, fill: 'forwards' },
      );
      if (!reduced) this.tickOnEachCell(strip, pitch);
      this.animation.finished.then(() => this.finish(), () => undefined);
    });
  }

  skip(): void {
    this.animation?.finish();
  }

  private finish(): void {
    if (!this.spinning()) return;
    cancelAnimationFrame(this.frame);
    // Park the strip on a whole pixel with no running animation: a composited, sub-pixel strip
    // resamples its bitmap and blurs the popped winner.
    if (this.stripEl) this.stripEl.style.transform = `translateX(${this.stopX}px)`;
    this.animation?.cancel();
    this.spinning.set(false);
    if (!document.hidden) this.revealSound(this.winTier());
    this.done.emit();
  }

  /** The stop sound grows with the tier: a ding, two notes for red, a major arpeggio for gold, a shimmer for mythical. */
  private revealSound(tier: RarityTier): void {
    // C6 major arpeggio (Hz), climbing into the next octaves for mythical.
    const notes = [1047, 1319, 1568, 2093, 2637, 3136, 4186];
    if (tier <= 2) return this.beep(880, 0.35, 'sine');
    if (tier === 3) return [880, 1319].forEach((hz, i) => this.beep(hz, 0.35, 'sine', i * 0.09));
    // Overlapping notes add up, so each is quieter than the single ding.
    if (tier === 4) return notes.slice(0, 4).forEach((hz, i) => this.beep(hz, 0.6, 'sine', i * 0.08, 0.6));
    notes.forEach((hz, i) => this.beep(hz, 0.7, 'sine', i * 0.07, 0.5));
    // Sparkle: octave pings above the run, fading out.
    for (let i = 0; i < 6; i++) this.beep(notes[4 + (i % 3)] * 2, 0.15, 'triangle', 0.5 + i * 0.12, 0.4 * (1 - i / 6));
  }

  /** Ticks every time a cell boundary passes the pointer, so the ticks slow down with the strip. */
  private tickOnEachCell(strip: HTMLElement, pitch: number): void {
    let last = -1;
    const step = () => {
      const x = -new DOMMatrixReadOnly(getComputedStyle(strip).transform).m41;
      const index = Math.floor(x / pitch);
      if (index !== last) {
        if (last >= 0) this.beep(1600, 0.03, 'triangle');
        last = index;
      }
      if (this.spinning()) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  /** One note `delay` seconds from now, at `gain` of the reel sound level. */
  private beep(frequency: number, seconds: number, type: OscillatorType, delay = 0, gain = 1): void {
    const level = this.player.isMuted() ? 0 : this.player.volume() * SOUND_LEVEL * gain;
    if (level <= 0) return;
    try {
      this.audio ??= this.openAudio();
      const now = this.audio.currentTime + delay;
      const osc = this.audio.createOscillator();
      const gain = this.audio.createGain();
      osc.type = type;
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(level, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
      osc.connect(gain).connect(this.audio.destination);
      osc.start(now);
      osc.stop(now + seconds);
    } catch {
      // No audio output available: the reel still works silently.
    }
  }

  private openAudio(): AudioContext {
    const audio = new AudioContext();
    void this.followPlaybackOutput(audio);
    return audio;
  }

  /** Sends the reel sounds to the device the player uses instead of the Windows default. */
  private async followPlaybackOutput(audio: AudioContext): Promise<void> {
    const sink = audio as AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };
    const id = this.player.preferredAudioOutputId();
    if (id === SYSTEM_DEFAULT_OUTPUT_ID || !sink.setSinkId) return;
    try {
      let sinkId = id;
      if (this.player.audioEngineBackend() !== 'chromium') {
        // Native ids are WASAPI endpoint ids; Chromium names the same endpoint with the same label.
        const name = this.player.preferredAudioOutputName();
        const outputs = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audiooutput');
        const match = outputs.find((device) => device.label === name)
          ?? outputs.find((device) => device.label && (device.label.includes(name) || name.includes(device.label)));
        if (!match) return;
        sinkId = match.deviceId;
      }
      await sink.setSinkId(sinkId);
    } catch {
      // Device gone or not selectable: keep the default output.
    }
  }
}
