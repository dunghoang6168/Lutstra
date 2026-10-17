import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { QueueEntry, Track } from '../models';
import { PlayerService, QueueAddResult } from './player.service';

export interface QueueNotice {
  message: string;
  action?: { label: string; run: () => void };
}

@Injectable({ providedIn: 'root' })
export class QueueActionsService implements OnDestroy {
  private readonly player = inject(PlayerService);
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  /** Runs once the current notice goes without its Undo (timed out, replaced or cleared). */
  private settle: (() => void) | null = null;

  readonly notice = signal<QueueNotice | null>(null);

  add(tracks: Track[]): QueueAddResult {
    const result = this.player.addToQueue(tracks);
    const firstAvailable = tracks.find((track) => track.isAvailable);

    if (result.addedCount === 0) {
      this.show('No available tracks to add');
    } else if (result.addedCount === 1) {
      this.show(`Added “${firstAvailable?.title ?? 'track'}” to queue`);
    } else {
      this.show(`Added ${result.addedCount} tracks to queue`);
    }

    return result;
  }

  notify(message: string): void {
    this.show(message);
  }

  clear(): void {
    this.runSettle();
    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    this.dismissTimer = null;
    this.notice.set(null);
  }

  clearWithUndo(): void {
    if (!this.player.queue().length) return;
    const snapshot = this.player.snapshotQueue();
    this.player.clearQueue();
    const notice = this.show('Queue cleared', {
      label: 'Undo',
      run: () => {
        if (this.notice() !== notice) return;
        this.clear();
        // A new queue started after clearing must not be replaced by an old Undo.
        if (this.player.queue().length) return;
        void this.player.restoreQueue(snapshot);
      },
    });
  }

  /**
   * Removes an upcoming entry with an Undo that puts it back in place. `kept` runs only if the removal stands,
   * so a suggestion taken out by mistake never tells Smart Shuffle it was unwanted.
   */
  removeWithUndo(entry: QueueEntry, kept?: () => void): void {
    const index = this.player.queue().findIndex((item) => item.id === entry.id);
    if (index < 0) return;
    this.player.removeFromQueue(entry.id);
    const notice = this.show(`Removed “${entry.track.title}”`, {
      label: 'Undo',
      run: () => {
        if (this.notice() !== notice) return;
        this.settle = null;
        this.clear();
        this.player.insertQueueEntry(entry, index);
      },
    });
    this.settle = kept ?? null;
  }

  private runSettle(): void {
    const settle = this.settle;
    this.settle = null;
    settle?.();
  }

  ngOnDestroy(): void {
    this.clear();
  }

  private show(message: string, action?: QueueNotice['action']): QueueNotice {
    this.runSettle();
    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    const notice = { message, action };
    this.notice.set(notice);
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      this.notice.set(null);
      this.runSettle();
    }, action ? 6000 : 3000);
    return notice;
  }
}
