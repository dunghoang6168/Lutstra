import { ChangeDetectionStrategy, Component, effect, input } from '@angular/core';
import { IconComponent, IconName } from '../icon/icon.component';
import { CoverSwap } from './cover-swap';

/** Artwork that crossfades to the next cover once it has decoded, at `--cover-fade-dur`. */
@Component({
  selector: 'app-cover-art',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './cover-art.component.html',
  styleUrl: './cover-art.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CoverArtComponent {
  readonly src = input<string | null | undefined>(null);
  readonly alt = input('');
  /** Placeholder glyph when there is no cover; null leaves the layer empty (backdrops, glows). */
  readonly icon = input<IconName | null>('disc');
  readonly iconSize = input(24);

  protected readonly swap = new CoverSwap((src) => {
    const image = new Image();
    image.src = src;
    return image.decode();
  });

  constructor() {
    effect(() => void this.swap.show(this.src() ?? null));
  }

  /** Swaps to `src` without the crossfade, for a caller animating the change itself; resolves once it is shown. */
  showNow(src: string | null): Promise<void> {
    return this.swap.show(src, false);
  }

  protected onAnimationEnd(event: AnimationEvent, id: number): void {
    if (event.target === event.currentTarget) this.swap.settle(id);
  }
}
