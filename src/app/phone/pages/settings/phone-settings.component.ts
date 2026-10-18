import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { LIBRARY_GATEWAY } from '../../../core/contracts';
import { ACCENT_SWATCHES, AccentColor, ThemePreset } from '../../../core/models';
import { ThemeService } from '../../../core/theme/theme.service';
import { ListeningHistoryService } from '../../../core/history/listening-history.service';
import { formatCount } from '../../../features/home/library-quality';
import { IconComponent } from '../../../shared/components/icon/icon.component';
import { PhoneLibraryService } from '../../phone-library.service';
import { UsbMode } from '../../../core/android/android-playback.engine';
import { loadOutput, output, requestBluetoothAccess, setUsbMode } from '../../app-shell';

const USB_MODES: { id: UsbMode; label: string; note: string }[] = [
  { id: 'shared', label: 'Shared', note: 'Android’s mixer at its own rate, together with every app’s sound.' },
  { id: 'match', label: 'File rate', note: 'The DAC runs at each file’s rate, so nothing is resampled. Android still mixes it. A change of rate between tracks can leave a short gap.' },
  { id: 'bitperfect', label: 'Bit-perfect', note: 'Lutstra’s audio reaches the DAC unmixed and unscaled; set the volume on the DAC. A stream the DAC has no bit-perfect format for plays at the file’s rate.' },
];

/** Settings for the phone: music folders, appearance (preset, accent or the wallpaper's), the USB DAC mode and listening history. */
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
  readonly output = output;
  readonly confirmBitPerfect = signal(false);
  readonly usbError = signal<string | null>(null);
  /** Shared always; the others when the plugged DAC offers them (or are the saved mode). */
  readonly usbModes = computed(() => {
    const out = this.output();
    return USB_MODES.filter((mode) => mode.id === 'shared' || mode.id === out?.usbMode
      || (mode.id === 'match' ? out?.usb?.match : out?.usb?.bitPerfect));
  });
  readonly usbModeNote = computed(() => USB_MODES.find((mode) => mode.id === this.output()?.usbMode)?.note ?? '');

  constructor() {
    void this.library.ensureLoaded();
    void loadOutput();
  }

  chooseUsbMode(mode: UsbMode): void {
    if (mode === this.output()?.usbMode) return;
    if (mode === 'bitperfect') this.confirmBitPerfect.set(true); else void this.applyUsbMode(mode);
  }

  readonly bluetoothNote = signal<string | null>(null);

  async allowBluetooth(): Promise<void> {
    this.bluetoothNote.set(null);
    try { await requestBluetoothAccess(); } catch { /* the note below covers it */ }
    // Android stops asking after two refusals; then only its app settings can turn it on.
    if (this.output()?.codecAccess === 'needed') this.bluetoothNote.set('Not allowed. Turn on Nearby devices for Lutstra in Android’s app settings.');
  }

  async applyUsbMode(mode: UsbMode): Promise<void> {
    this.confirmBitPerfect.set(false);
    this.usbError.set(null);
    try { await setUsbMode(mode); } catch { this.usbError.set('Couldn’t change the USB output. Try again.'); }
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
