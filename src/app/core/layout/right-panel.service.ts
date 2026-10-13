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
  /** Set by the developer Random folder session while its round owns the queue. */
  readonly randomSessionActive = signal(false);
  /** Upcoming tracks stay a surprise on the Random folder page and during its rounds. */
  readonly queueHidden = computed(() => this.hiddenOnPage() || this.randomSessionActive());

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
