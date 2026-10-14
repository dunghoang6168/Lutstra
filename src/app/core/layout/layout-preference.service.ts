import { inject, Injectable, signal } from '@angular/core';
import { SETTINGS_GATEWAY } from '../contracts';
import { DEFAULT_LAYOUT_MODE, isLayoutMode, LayoutMode } from '../models';

export type LayoutSaveState = 'idle' | 'saving' | 'saved' | 'error';

@Injectable({ providedIn: 'root' })
export class LayoutPreferenceService {
  private readonly settingsGateway = inject(SETTINGS_GATEWAY);
  private readonly modeState = signal<LayoutMode>(DEFAULT_LAYOUT_MODE);
  private readonly saveStateValue = signal<LayoutSaveState>('idle');
  private readonly errorMessageValue = signal<string | null>(null);
  private persistedMode: LayoutMode = DEFAULT_LAYOUT_MODE;
  private saveQueue: Promise<void> = Promise.resolve();
  private saveRevision = 0;

  private readonly ambientArtworkState = signal(true);
  private persistedAmbientArtwork = true;

  readonly mode = this.modeState.asReadonly();
  /** Ambient's blurred artwork ground; off leaves the glass over the plain theme canvas. */
  readonly ambientArtwork = this.ambientArtworkState.asReadonly();
  readonly saveState = this.saveStateValue.asReadonly();
  readonly errorMessage = this.errorMessageValue.asReadonly();

  async restore(): Promise<void> {
    try {
      const settings = await this.settingsGateway.getSettings();
      this.persistedMode = isLayoutMode(settings.layoutMode) ? settings.layoutMode : DEFAULT_LAYOUT_MODE;
      this.modeState.set(this.persistedMode);
      this.persistedAmbientArtwork = settings.ambientArtwork !== false;
      this.ambientArtworkState.set(this.persistedAmbientArtwork);
      this.saveStateValue.set('idle');
      this.errorMessageValue.set(null);
    } catch (error) {
      this.persistedMode = DEFAULT_LAYOUT_MODE;
      this.modeState.set(this.persistedMode);
      this.saveStateValue.set('error');
      this.errorMessageValue.set(errorMessage(error, 'Failed to restore layout setting'));
    }
  }

  setMode(mode: LayoutMode): Promise<void> {
    if (mode === this.modeState() && this.saveState() !== 'error') return this.saveQueue;
    this.modeState.set(mode);
    this.saveStateValue.set('saving');
    this.errorMessageValue.set(null);
    const revision = ++this.saveRevision;
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await this.settingsGateway.saveSettings({ layoutMode: mode });
        this.persistedMode = mode;
        if (revision === this.saveRevision) this.saveStateValue.set('saved');
      } catch (error) {
        if (revision === this.saveRevision) {
          this.modeState.set(this.persistedMode);
          this.saveStateValue.set('error');
          this.errorMessageValue.set(errorMessage(error, 'Failed to save layout setting'));
        }
      }
    });
    return this.saveQueue;
  }

  setAmbientArtwork(enabled: boolean): Promise<void> {
    if (enabled === this.ambientArtworkState()) return this.saveQueue;
    this.ambientArtworkState.set(enabled);
    this.saveStateValue.set('saving');
    this.errorMessageValue.set(null);
    const revision = ++this.saveRevision;
    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await this.settingsGateway.saveSettings({ ambientArtwork: enabled });
        this.persistedAmbientArtwork = enabled;
        if (revision === this.saveRevision) this.saveStateValue.set('saved');
      } catch (error) {
        if (revision === this.saveRevision) {
          this.ambientArtworkState.set(this.persistedAmbientArtwork);
          this.saveStateValue.set('error');
          this.errorMessageValue.set(errorMessage(error, 'Failed to save Ambient artwork setting'));
        }
      }
    });
    return this.saveQueue;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
