import { Component, computed, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { orderAlbumTracks } from '../../../core/models/album-track-order';
import { formatAlbumFormat } from '../../../features/home/library-quality';
import { PhoneDetailHeaderComponent } from '../../components/detail-header/phone-detail-header.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { collectionMeasure } from '../collection-measure';

@Component({
  selector: 'app-phone-album',
  standalone: true,
  imports: [PhoneDetailHeaderComponent, PhoneTrackRowComponent],
  templateUrl: './phone-album.component.html',
  styleUrls: ['../../phone-lists.scss'],
})
export class PhoneAlbumComponent {
  readonly library = inject(PhoneLibraryService);
  private readonly id = toSignal(inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('id'))));
  readonly album = computed(() => this.library.snapshot()?.albums.find((album) => album.id === this.id()) ?? null);
  readonly tracks = computed(() => orderAlbumTracks(this.library.tracksOf(this.album()?.trackIds ?? [])));
  readonly format = computed(() => formatAlbumFormat(this.tracks()));
  readonly subtitle = computed(() => {
    const album = this.album();
    return album ? [album.artist ?? 'Unknown artist', album.year].filter(Boolean).join(' · ') : null;
  });
  readonly measure = computed(() => collectionMeasure(this.tracks(), this.format()?.label));

  constructor() {
    void this.library.ensureLoaded();
  }
}
