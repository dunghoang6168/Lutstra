import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { compareAlbumTracks } from '../../../core/models/album-track-order';
import { albumFormatMap } from '../../../features/home/library-quality';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneDetailHeaderComponent } from '../../components/detail-header/phone-detail-header.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { collectionMeasure } from '../collection-measure';

const text = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

@Component({
  selector: 'app-phone-artist',
  standalone: true,
  imports: [RouterLink, CoverArtComponent, PhoneDetailHeaderComponent, PhoneTrackRowComponent],
  templateUrl: './phone-artist.component.html',
  styleUrls: ['../../phone-lists.scss'],
})
export class PhoneArtistComponent {
  readonly library = inject(PhoneLibraryService);
  private readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('id'))));
  readonly artist = computed(() => this.library.snapshot()?.artists.find((artist) => artist.id === this.id()) ?? null);
  /** Newest first, as a discography reads. */
  readonly albums = computed(() => {
    const ids = new Set(this.artist()?.albumIds ?? []);
    return (this.library.snapshot()?.albums ?? []).filter((album) => ids.has(album.id))
      .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || text.compare(a.title, b.title));
  });
  readonly albumFormats = computed(() => albumFormatMap(this.albums(), this.library.snapshot()?.tracks ?? []));
  /** Album by album in disc and track order; loose tracks last. */
  readonly tracks = computed(() => this.library.tracksOf(this.artist()?.trackIds ?? [])
    .sort((a, b) => (a.album ? 0 : 1) - (b.album ? 0 : 1) || text.compare(a.album ?? '', b.album ?? '') || compareAlbumTracks(a, b)));
  readonly subtitle = computed(() => {
    const count = this.albums().length;
    return `${count} ${count === 1 ? 'album' : 'albums'}`;
  });
  readonly measure = computed(() => collectionMeasure(this.tracks()));

  constructor() {
    void this.library.ensureLoaded();
  }
}
