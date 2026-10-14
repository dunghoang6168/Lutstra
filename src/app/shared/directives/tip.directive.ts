import { booleanAttribute, Directive, effect, ElementRef, inject, input, OnDestroy } from '@angular/core';

export type TipPlacement = 'top' | 'right' | 'bottom';

const GAP_PX = 10;
const EDGE_PX = 8;
/** Truncated text waits a beat so sweeping across a table does not flicker a tip per row. */
const OVERFLOW_DELAY_MS = 450;

// One top-layer popover serves every tip in the app; each host only borrows it while hovered or focused.
let tipEl: HTMLElement | null = null;
let owner: TipDirective | null = null;

function sharedTip(): HTMLElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'app-tip';
    tipEl.setAttribute('popover', 'manual');
    tipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/**
 * Styled tooltip. `appTip="Label"` shows at once (icon-only controls; keep their aria-label).
 * `appTipOverflow` shows the host's own text after a short delay, only while it is truncated.
 */
@Directive({
  selector: '[appTip],[appTipOverflow]',
  standalone: true,
  host: {
    '(mouseenter)': 'show()',
    '(focus)': 'onFocus()',
    '(mouseleave)': 'hide()',
    '(blur)': 'hide()',
  },
})
export class TipDirective implements OnDestroy {
  readonly text = input('', { alias: 'appTip' });
  readonly overflow = input(false, { alias: 'appTipOverflow', transform: booleanAttribute });
  readonly placement = input<TipPlacement>('top', { alias: 'tipPlacement' });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private timer?: ReturnType<typeof setTimeout>;

  constructor() {
    // A label that changes while shown (Play → Pause after a click) updates in place.
    effect(() => {
      const text = this.text();
      if (owner === this && tipEl && !this.overflow()) this.open(text);
    });
  }

  onFocus(): void {
    if (this.host.matches(':focus-visible')) this.show();
  }

  show(): void {
    clearTimeout(this.timer);
    if (this.overflow()) {
      // Ellipsis or line-clamp; the 1px slack keeps single-line descenders from counting as overflow.
      const h = this.host;
      if (h.scrollWidth <= h.clientWidth && h.scrollHeight <= h.clientHeight + 1) return;
      // Template whitespace would otherwise show as line breaks (the tip keeps \n for multi-line labels).
      const text = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
      this.timer = setTimeout(() => this.open(text), OVERFLOW_DELAY_MS);
    } else {
      this.open(this.text());
    }
  }

  hide(): void {
    clearTimeout(this.timer);
    if (owner !== this || !tipEl) return;
    owner = null;
    if (tipEl.matches(':popover-open')) tipEl.hidePopover();
  }

  ngOnDestroy(): void {
    this.hide();
  }

  private open(text: string): void {
    if (!text || !this.host.isConnected) return;
    const tip = sharedTip();
    owner = this;
    tip.textContent = text;
    tip.dataset['placement'] = this.placement();
    if (!tip.matches(':popover-open')) tip.showPopover();

    const r = this.host.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left: number;
    let top: number;
    if (this.placement() === 'right') {
      left = r.right + GAP_PX;
      top = r.top + r.height / 2 - h / 2;
    } else {
      left = r.left + r.width / 2 - w / 2;
      top = this.placement() === 'top' ? r.top - GAP_PX - h : r.bottom + GAP_PX;
    }
    tip.style.left = `${Math.max(EDGE_PX, Math.min(left, innerWidth - w - EDGE_PX))}px`;
    tip.style.top = `${Math.max(EDGE_PX, Math.min(top, innerHeight - h - EDGE_PX))}px`;
  }
}
