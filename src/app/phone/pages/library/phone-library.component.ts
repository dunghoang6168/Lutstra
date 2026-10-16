import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LIBRARY_GATEWAY } from '../../../core/contracts';
import { Track } from '../../../core/models';
import { PlayerService } from '../../../core/player/player.service';
import { formatTrackFormat } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';

const byTitle = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** P0: every track by title, enough to start playback. The chip tabs and detail pages arrive in P1. */
@Component({
  selector: 'app-phone-library',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './phone-library.component.html',
  styleUrl: './phone-library.component.scss',
})
export class PhoneLibraryComponent {
  readonly player = inject(PlayerService);
  private readonly library = inject(LIBRARY_GATEWAY);
  readonly tracks = signal<Track[]>([]);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly rows = computed(() => this.tracks().map((track) => ({ track, format: formatTrackFormat(track) })));

  constructor() {
    this.library.libraryChanged$?.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe(() => void this.load());
    void this.load();
  }

  play(index: number): void {
    void this.player.playCollection(this.tracks(), index);
  }

  private async load(): Promise<void> {
    try {
      const { tracks } = await this.library.getLibrary();
      this.tracks.set([...tracks].sort((a, b) => byTitle.compare(a.title, b.title)));
      this.error.set(null);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Failed to load the library');
    } finally {
      this.loading.set(false);
    }
  }
}
