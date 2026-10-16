import { Component, ElementRef, afterNextRender, computed, inject, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { normalizeSearch, rankMatches } from '../../../shared/utils/search-rank';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { CoverArtComponent } from '../../../shared/components/cover-art/cover-art.component';
import { PhoneTrackRowComponent } from '../../components/track-row/phone-track-row.component';
import { PhoneLibraryService } from '../../phone-library.service';

/** One field over tracks, albums, artists and playlists, ranked like the desktop search. The query lives in `?q=`. */
@Component({
  selector: 'app-phone-search',
  standalone: true,
  imports: [RouterLink, IconComponent, CoverArtComponent, PhoneTrackRowComponent],
  templateUrl: './phone-search.component.html',
  styleUrls: ['../../phone-lists.scss', './phone-search.component.scss'],
})
export class PhoneSearchComponent {
  readonly library = inject(PhoneLibraryService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  readonly query = toSignal(this.route.queryParamMap.pipe(map((params) => params.get('q') ?? '')), { initialValue: '' });
  private readonly normalized = computed(() => normalizeSearch(this.query().trim()));
  readonly songs = computed(() => this.rank((s) => s.tracks, (track) => track.title, (track) => [track.artist, track.album, track.fileName]).slice(0, 20));
  readonly albums = computed(() => this.rank((s) => s.albums, (album) => album.title, (album) => [album.artist]).slice(0, 10));
  readonly artists = computed(() => this.rank((s) => s.artists, (artist) => artist.name, () => []).slice(0, 10));
  readonly playlists = computed(() => this.normalized()
    ? rankMatches(this.library.playlists(), this.normalized(), (playlist) => playlist.name, () => []).slice(0, 10) : []);
  readonly empty = computed(() => !!this.normalized() && !this.songs().length && !this.albums().length
    && !this.artists().length && !this.playlists().length);

  constructor() {
    void this.library.ensureLoaded();
    void this.library.loadPlaylists();
    // Coming back with results (Back from an album) keeps the keyboard down.
    afterNextRender(() => { if (!this.query()) this.field()?.nativeElement.focus(); });
  }

  onInput(event: Event): void {
    const q = (event.target as HTMLInputElement).value;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { q: q || null }, replaceUrl: true });
  }

  clear(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { q: null }, replaceUrl: true });
    this.field()?.nativeElement.focus();
  }

  private rank<T>(pick: (snapshot: NonNullable<ReturnType<PhoneLibraryService['snapshot']>>) => T[],
    primary: (item: T) => string, secondary: (item: T) => Array<string | null>): T[] {
    const snapshot = this.library.snapshot();
    return snapshot && this.normalized() ? rankMatches(pick(snapshot), this.normalized(), primary, secondary) : [];
  }
}
