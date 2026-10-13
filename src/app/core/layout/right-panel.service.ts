import { Injectable, computed, signal } from '@angular/core';

export type RightPanelKind = 'queue' | 'track-details' | null;

@Injectable({ providedIn: 'root' })
export class RightPanelService {
  readonly activePanel = signal<RightPanelKind>(null);
  readonly trackDetailsWidth = signal(600);
  readonly isQueueOpen = computed(() => this.activePanel() === 'queue');
  readonly isTrackDetailsOpen = computed(() => this.activePanel() === 'track-details');
  private trackDetailsOpener: HTMLElement | null = null;

  private readonly hiddenOnPage = signal(false);
  /** Hidden on the Random folder page; elsewhere the queue shows even while a roulette round plays. */
  readonly queueHidden = computed(() => this.hiddenOnPage());

  hideQueue(hidden: boolean): void {
    this.hiddenOnPage.set(hidden);
    if (hidden) this.closeQueue();
  }

  toggleQueue(): void {
    if (this.queueHidden()) return;
    if (this.activePanel() === 'track-details') this.trackDetailsOpener = null;
    this.activePanel.update((current) => current === 'queue' ? null : 'queue');
  }

  openTrackDetails(opener?: HTMLElement | null): void {
    this.trackDetailsOpener = opener ?? null;
    this.activePanel.set('track-details');
  }

  closeQueue(): void {
    if (this.activePanel() === 'queue') this.activePanel.set(null);
  }

  closeTrackDetails(restoreFocus = true): void {
    const wasOpen = this.activePanel() === 'track-details';
    if (wasOpen) this.activePanel.set(null);
    const opener = this.trackDetailsOpener;
    this.trackDetailsOpener = null;
    if (wasOpen && restoreFocus && opener?.isConnected) queueMicrotask(() => opener.focus());
  }

  closeActive(): void {
    if (this.activePanel() === 'track-details') this.closeTrackDetails();
    else this.activePanel.set(null);
  }

  setTrackDetailsWidth(width: number): void {
    this.trackDetailsWidth.set(Math.round(width));
  }
}
