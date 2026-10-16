import { Component, ElementRef, afterNextRender, computed, inject, viewChild } from '@angular/core';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { PhoneLibraryService } from '../../phone-library.service';

/** The ⋯ bottom sheet: Play next, Add to queue, Add to playlist. It closes on Escape, which Android Back sends. */
@Component({
  selector: 'app-phone-track-actions-sheet',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './phone-track-actions-sheet.component.html',
  styleUrl: './phone-track-actions-sheet.component.scss',
})
export class PhoneTrackActionsSheetComponent {
  readonly library = inject(PhoneLibraryService);
  private readonly firstAction = viewChild<ElementRef<HTMLButtonElement>>('firstAction');
  private readonly opener = document.activeElement as HTMLElement | null;
  readonly tracks = computed(() => this.library.actionTracks() ?? []);
  readonly title = computed(() => this.tracks().length === 1 ? this.tracks()[0].title : `${this.tracks().length} tracks`);

  constructor() {
    afterNextRender(() => this.firstAction()?.nativeElement.focus());
  }

  close(): void {
    this.library.actionTracks.set(null);
    if (this.opener?.isConnected) this.opener.focus();
  }

  playNext(): void {
    this.library.playNext(this.tracks());
    this.close();
  }

  addToQueue(): void {
    this.library.addToQueue(this.tracks());
    this.close();
  }

  addToPlaylist(): void {
    const tracks = this.tracks();
    // The ⋯ button gets focus back first, so the dialog returns focus there when it closes.
    this.close();
    this.library.playlistTracks.set(tracks);
  }
}
