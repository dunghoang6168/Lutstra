import { Injectable, NgZone, inject, signal } from '@angular/core';

/** Past this much travel (CSS px) a released drag carries on its way, as PixelPlayer's sheet does (5 dp). */
const COMMIT_PX = 5;
/** Or flicked faster than this (px/s). */
const COMMIT_SPEED = 150;
/** Springs, as Compose's: stiffness and damping ratio. Opening settles without bounce; closing gets a little. */
const OPEN_SPRING = { stiffness: 400, damping: 1 };
const CLOSE_STIFFNESS = 200;
const CLOSE_DAMPING_OPEN = 0.75;

/**
 * Where a released drag sends the sheet, after PixelPlayer's `resolveVerticalSheetTargetState`: an open sheet
 * pulled back up stays open; past a few pixels the drag's direction wins; then a flick's; then the halfway mark.
 * `dy` is the drag's travel since it began (down is positive), `vy` its speed in px/s, `f` how open the sheet is.
 */
export function releaseTarget(wasOpen: boolean, dy: number, vy: number, f: number): 0 | 1 {
  if (wasOpen && dy <= 0) return 1;
  if (Math.abs(dy) > COMMIT_PX) return dy < 0 ? 1 : 0;
  if (Math.abs(vy) > COMMIT_SPEED) return vy < 0 ? 1 : 0;
  return f > 0.5 ? 1 : 0;
}

/** The elements that draw the sheet; the shell hands them over. */
export interface SheetParts {
  /** Now Playing's host, which rides up from the mini player's place. */
  sheet?: HTMLElement;
  /** Now Playing's content, which fades in as it opens. */
  fades: Iterable<HTMLElement>;
  scrim?: HTMLElement;
  mini?: HTMLElement;
}

/**
 * The mini player and Now Playing as one sheet, after PixelPlayer's: `f` runs from 0 (the mini player) to 1
 * (Now Playing). Each frame writes only translate, clip and opacity on the parts themselves, as PixelPlayer's
 * graphicsLayer does, so nothing else restyles: a custom property would restyle everything under each part.
 * A finger moves `f` directly; a release, a tap or Back sends it home on a spring. Runs outside Angular per frame,
 * and enters it only to change the signals.
 */
@Injectable({ providedIn: 'root' })
export class PlayerSheetService {
  /** Now Playing is open or opening; the shell under it is inert. */
  readonly open = signal(false);
  /** Now Playing is on screen at all: open, or part way while a drag or a glide moves it. */
  readonly shown = signal(false);
  /**
   * Now Playing has come to rest open over the page, which is inert under it. Set once the sheet stops and cleared
   * once it is gone, never as it starts to move: inert restyles the whole page, which would cost the first frames.
   */
  readonly covering = signal(false);
  private readonly zone = inject(NgZone);
  private parts: () => SheetParts = () => ({ fades: [] });
  private f = 0;
  private miniTop = innerHeight;
  private miniHeight = 0;
  private travel = 1;
  private frame = 0;

  attach(parts: () => SheetParts): void {
    this.parts = parts;
    this.write(0);
  }

  /** A tap on the mini player. */
  expand(velocity = 0): void {
    this.setWillChange(true);
    this.measure();
    this.zone.run(() => { this.open.set(true); this.shown.set(true); });
    this.animate(1, velocity, OPEN_SPRING);
  }

  /** The close button, Back, or a drag let go on the way down. */
  collapse(velocity = 0): void {
    this.zone.run(() => this.open.set(false));
    const damping = CLOSE_DAMPING_OPEN + (1 - CLOSE_DAMPING_OPEN) * (1 - this.f);
    this.animate(0, velocity, { stiffness: CLOSE_STIFFNESS, damping });
  }

  /** At once, with no motion: a page link inside Now Playing has navigated away. */
  closeNow(): void {
    cancelAnimationFrame(this.frame);
    this.write(0);
    this.setWillChange(false);
    this.open.set(false);
    this.shown.set(false);
    this.covering.set(false);
  }

  /** A finger took hold of the sheet (on the mini player, or anywhere on Now Playing). */
  beginDrag(): number {
    cancelAnimationFrame(this.frame);
    this.setWillChange(true);
    this.measure();
    if (!this.shown()) this.zone.run(() => this.shown.set(true));
    return this.f;
  }

  /** `from` is `f` when the drag began and `dy` the finger's travel since (down is positive). */
  dragTo(from: number, dy: number): void {
    this.write(Math.min(1, Math.max(0, from - dy / this.travel)));
  }

  endDrag(dy: number, vy: number): void {
    // Velocity in sheets per second, up being open.
    const velocity = -vy / this.travel;
    if (releaseTarget(this.open(), dy, vy, this.f) === 1) this.expand(velocity);
    else this.collapse(velocity);
  }

  /**
   * The mini player's place, which the sheet opens from and closes to; without one it rises from the bottom.
   * Read only while the card is at rest: once the sheet is on screen the card rides its top edge, and the page
   * under the sheet does not move, so the last reading still holds.
   */
  private measure(): void {
    if (this.shown()) return;
    const rect = this.parts().mini?.getBoundingClientRect();
    this.miniTop = rect?.top ?? innerHeight;
    this.miniHeight = rect?.height ?? 0;
    this.travel = Math.max(1, this.miniTop);
    this.paint();
  }

  /** Draws the sheet as it stands; the shell calls it again whenever one of the parts is created. */
  paint(): void {
    this.write(this.f);
  }

  /**
   * Keeps each moving part on its own compositor layer while the sheet shows. Without it the WebView rebuilt the
   * layers mid-motion (as an opacity reached 0 or 1) and showed one frame without Now Playing's controls.
   */
  private setWillChange(active: boolean): void {
    const { sheet, fades, scrim, mini } = this.parts();
    const value = active ? 'opacity, transform' : '';
    for (const part of [sheet, ...fades, scrim, mini]) if (part && part.style.willChange !== value) part.style.willChange = value;
  }

  /**
   * At `f` Now Playing's top edge rides up from the mini player's top, its bottom is clipped back to the card's,
   * and its side margin and corners shrink to 0; the card rides its top edge and is gone by halfway.
   */
  private write(f: number): void {
    this.f = f;
    const { sheet, fades, scrim, mini } = this.parts();
    // A part made while the sheet shows (the scrim) needs its layer from its first frame.
    if (f > 0) this.setWillChange(true);
    const g = (1 - f).toFixed(4);
    if (sheet) {
      sheet.style.translate = `0 ${((1 - f) * this.miniTop).toFixed(1)}px`;
      sheet.style.clipPath = `inset(0 calc(${g} * var(--space-2)) calc(${g} * (100% - ${this.miniHeight}px)) round calc(${g} * var(--radius-xl)))`;
    }
    for (const fade of fades) fade.style.opacity = f.toFixed(3);
    if (scrim) scrim.style.opacity = (f * 0.5).toFixed(3);
    if (mini) {
      mini.style.translate = `0 ${(-f * this.miniTop).toFixed(1)}px`;
      mini.style.opacity = Math.max(0, 1 - 2 * f).toFixed(3);
    }
  }

  /** A spring to `target` (0 or 1); closing stops where it reaches the mini player, which then gives a small squash. */
  private animate(target: 0 | 1, velocity: number, spring: { stiffness: number; damping: number }): void {
    cancelAnimationFrame(this.frame);
    const done = (): void => {
      this.write(target);
      if (target === 1) { this.zone.run(() => this.covering.set(true)); return; }
      this.setWillChange(false);
      this.zone.run(() => { this.shown.set(false); this.covering.set(false); });
      this.squashMini();
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    const c = 2 * spring.damping * Math.sqrt(spring.stiffness);
    let x = this.f;
    let v = velocity;
    let last = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(1 / 30, (now - last) / 1000);
      last = now;
      v += (-spring.stiffness * (x - target) - c * v) * dt;
      x += v * dt;
      if ((target === 0 && x <= 0) || (Math.abs(x - target) < 0.001 && Math.abs(v) < 0.01)) { done(); return; }
      this.write(Math.min(1, x));
      this.frame = requestAnimationFrame(step);
    };
    this.zone.runOutsideAngular(() => { this.frame = requestAnimationFrame(step); });
  }

  /** PixelPlayer's landing: the card gives a little and springs back. */
  private squashMini(): void {
    this.parts().mini?.animate(
      [{ scale: '1 0.97' }, { scale: '1 1.015', offset: 0.45 }, { scale: '1 1' }],
      { duration: 420, easing: 'cubic-bezier(0.2, 0, 0, 1)' },
    );
  }
}
