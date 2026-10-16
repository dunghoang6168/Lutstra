import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { Track } from '../../../core/models';
import { PhoneDetailHeaderComponent } from '../../components/detail-header/phone-detail-header.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { collectionMeasure } from '../collection-measure';

@Component({
  selector: 'app-phone-playlist',
  standalone: true,
  imports: [PhoneDetailHeaderComponent, PhoneTrackRowComponent],
  templateUrl: './phone-playlist.component.html',
  styleUrls: ['../../phone-lists.scss'],
})
export class PhonePlaylistComponent {
  readonly library = inject(PhoneLibraryService);
  private readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('id'))));
  readonly playlist = computed(() => this.library.playlists().find((playlist) => playlist.id === this.id()) ?? null);
  /** Entry order, duplicates kept; entries whose file left the library are skipped. */
  readonly entries = computed(() => {
    const byId = this.library.trackById();
    return (this.playlist()?.entries ?? []).flatMap((entry) => {
      const track = byId.get(entry.trackId);
      return track ? [{ id: entry.id, track }] : [];
    });
  });
  readonly tracks = computed<Track[]>(() => this.entries().map((entry) => entry.track));
  readonly missing = computed(() => (this.playlist()?.entries.length ?? 0) - this.entries().length);
  readonly measure = computed(() => collectionMeasure(this.tracks()));
  readonly loaded = computed(() => this.library.snapshot() !== null);

  constructor() {
    void this.library.ensureLoaded();
    void this.library.loadPlaylists();
  }
}
