import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { LIBRARY_GATEWAY } from '../../../core/contracts';
import { ACCENT_SWATCHES, AccentColor, ThemePreset } from '../../../core/models';
import { ThemeService } from '../../../core/theme/theme.service';
import { ListeningHistoryService } from '../../../core/history/listening-history.service';
import { formatCount } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { PhoneLibraryService } from '../../phone-library.service';

/** Settings for the phone: music folders, appearance (preset, accent or the wallpaper's) and listening history. */
@Component({
  selector: 'app-phone-settings',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './phone-settings.component.html',
  styleUrls: ['../../phone-lists.scss', './phone-settings.component.scss'],
})
export class PhoneSettingsComponent {
  readonly theme = inject(ThemeService);
  readonly library = inject(PhoneLibraryService);
  private readonly gateway = inject(LIBRARY_GATEWAY);
  private readonly history = inject(ListeningHistoryService);
  readonly swatches = ACCENT_SWATCHES;
  readonly presets: { id: ThemePreset; label: string }[] = [{ id: 'dark', label: 'Dark' }, { id: 'light', label: 'Light' }];
  readonly scan = toSignal(this.gateway.scanProgress$);
  readonly folders = computed(() => this.library.snapshot()?.folders ?? []);
  readonly trackCount = computed(() => formatCount.format(this.library.snapshot()?.tracks.length ?? 0));
  readonly choosing = signal(false);
  readonly folderError = signal<string | null>(null);
  readonly confirmClear = signal(false);
  readonly historyNote = signal<string | null>(null);

  constructor() {
    void this.library.ensureLoaded();
  }

  async chooseFolders(): Promise<void> {
    if (this.choosing()) return;
    this.choosing.set(true);
    this.folderError.set(null);
    try {
      await this.gateway.selectAndAddMusicFolders();
    } catch (error) {
      this.folderError.set(error instanceof Error ? error.message : 'Couldn’t open the folder picker. Try again.');
    } finally {
      this.choosing.set(false);
    }
  }

  rescan(): void {
    this.folderError.set(null);
    this.gateway.requestScan().catch((error) => this.folderError.set(error instanceof Error ? error.message : String(error)));
  }

  setAccent(id: AccentColor): void {
    void this.theme.setAccentColor(id);
  }

  async clearHistory(): Promise<void> {
    try {
      await this.history.clear();
      this.historyNote.set('History cleared.');
    } catch {
      this.historyNote.set('Couldn’t clear the history. Try again.');
    } finally {
      this.confirmClear.set(false);
    }
  }
}
