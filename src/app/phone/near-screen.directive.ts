import { DestroyRef, Directive, ElementRef, inject, output } from '@angular/core';

/** Emits when the element comes within a screen of the visible area; a long list's end marker uses it to render more. */
@Directive({ selector: '[appNearScreen]', standalone: true })
export class NearScreenDirective {
  readonly appNearScreen = output<void>();

  constructor() {
    const observer = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) this.appNearScreen.emit(); },
      { rootMargin: '100% 0px' },
    );
    observer.observe(inject(ElementRef).nativeElement);
    inject(DestroyRef).onDestroy(() => observer.disconnect());
  }
}
