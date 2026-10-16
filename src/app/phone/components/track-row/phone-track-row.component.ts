import { Component, computed, inject, input, output } from '@angular/core';
import { Track } from '../../../core/models';
import { PlayerService } from '../../../core/player/player.service';
import { formatTrackFormat } from '../../../features/home/library-quality';
import { DurationPipe } from '../../../shared/pipes/duration.pipe';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneLibraryService } from '../../phone-library.service';

/** One track: tap plays it, ⋯ opens the action sheet. With `number`, the track number replaces the cover (album pages). */
@Component({
  selector: 'app-phone-track-row',
  standalone: true,
  imports: [DurationPipe, IconComponent, CoverArtComponent],
  templateUrl: './phone-track-row.component.html',
  styleUrl: './phone-track-row.component.scss',
})
export class PhoneTrackRowComponent {
  readonly track = input.required<Track>();
  readonly number = input<number | null | undefined>(undefined);
  readonly play = output<void>();
  private readonly player = inject(PlayerService);
  private readonly library = inject(PhoneLibraryService);
  readonly playing = computed(() => this.player.currentTrack()?.id === this.track().id);
  readonly format = computed(() => formatTrackFormat(this.track()));

  openActions(): void {
    this.library.openActions([this.track()]);
  }
}
