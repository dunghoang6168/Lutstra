import { DestroyRef, Directive, ElementRef, effect, inject, input } from '@angular/core';
import { CoverTone } from './cover-tone';
import { readTone } from './cover-tone.service';

/** Tones already read, by cover address, so a list read once stays read. */
// ponytail: unbounded cache; fine for one library's covers, cap it if libraries grow past a few thousand albums.
const tones = new Map<string, Promise<CoverTone | null>>();

/**
 * Gives the host the `.cover-tinted` colours of a cover (--np-hue, --np-chroma), as Now Playing does for the
 * playing track: the Library's album cards, after PixelPlayer's. The cover is read once it nears the screen.
 */
@Directive({ selector: '[appCoverTone]', standalone: true, host: { class: 'cover-tinted' } })
export class CoverToneDirective {
  readonly src = input<string | null | undefined>(null, { alias: 'appCoverTone' });

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    let near = false;
    const paint = (): void => {
      const src = this.src();
      if (!near || !src) return;
      if (!tones.has(src)) tones.set(src, readTone(src));
      void tones.get(src)!.then((tone) => {
        if (src !== this.src()) return;
        host.style.setProperty('--np-hue', String(tone?.hue ?? 0));
        host.style.setProperty('--np-chroma', String(tone?.chroma ?? 0));
      });
    };
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      near = true;
      observer.disconnect();
      paint();
    }, { rootMargin: '50% 0px' });
    observer.observe(host);
    effect(paint);
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }
}
