import { signal } from '@angular/core';

export interface CoverLayer {
  id: number;
  src: string | null;
  /** False only for the first cover, which appears without a fade. */
  fade: boolean;
}

/**
 * Keeps the shown cover until the next one has decoded, then stacks the new one on top to fade in.
 * Only the latest request wins, and at most two layers are ever on screen.
 */
export class CoverSwap {
  readonly layers = signal<CoverLayer[]>([]);
  private target: string | null = null;
  private nextId = 0;

  constructor(private readonly decode: (src: string) => Promise<unknown>) {}

  async show(src: string | null): Promise<void> {
    this.target = src;
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
    this.layers.set([current!, { id: ++this.nextId, src, fade: true }]);
  }

  /** The layer with this id has finished fading in; drop the ones under it. */
  settle(id: number): void {
    this.layers.update((layers) => (layers.length > 1 && layers.at(-1)!.id === id ? [layers.at(-1)!] : layers));
  }
}
