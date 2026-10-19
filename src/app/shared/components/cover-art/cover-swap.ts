import { signal } from '@angular/core';

export interface CoverLayer {
  id: number;
  src: string | null;
  /** False for the first cover and for a swap asked to skip its fade. */
  fade: boolean;
}

/**
 * Keeps the shown cover until the next one has decoded, then stacks the new one on top to fade in.
 * Only the latest request wins, and at most two layers are ever on screen.
 */
export class CoverSwap {
  readonly layers = signal<CoverLayer[]>([]);
  private target: string | null | undefined;
  private instant = false;
  private pending: Promise<void> = Promise.resolve();
  private nextId = 0;

  constructor(private readonly decode: (src: string) => Promise<unknown>) {}

  /**
   * Resolves once `src` is the top layer (or another request has taken over). `fade: false` replaces the
   * cover outright, for a caller that is already animating the change; asking again for the same cover
   * joins the pending swap, and a `fade: false` ask wins either way.
   */
  show(src: string | null, fade = true): Promise<void> {
    if (src === this.target) {
      if (!fade) this.instant = true;
      return this.pending;
    }
    this.target = src;
    this.instant = !fade;
    return (this.pending = this.swapTo(src));
  }

  private async swapTo(src: string | null): Promise<void> {
    const top = this.layers().at(-1);
    if (!top) {
      this.layers.set([{ id: ++this.nextId, src, fade: false }]);
      return;
    }
    if (top.src === src) return;
    // A cover that fails to decode still swaps in, like a plain <img> would.
    if (src) await this.decode(src).catch(() => undefined);
    const current = this.layers().at(-1);
    if (this.target !== src || current?.src === src) return;
    const layer = { id: ++this.nextId, src, fade: !this.instant };
    this.layers.set(this.instant ? [layer] : [current!, layer]);
  }

  /** The layer with this id has finished fading in; drop the ones under it. */
  settle(id: number): void {
    this.layers.update((layers) => (layers.length > 1 && layers.at(-1)!.id === id ? [layers.at(-1)!] : layers));
  }
}
