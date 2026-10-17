import { DOCUMENT } from '@angular/common';
import { Capacitor } from '@capacitor/core';
import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { SETTINGS_GATEWAY } from '../contracts';
import { LayoutPreferenceService } from '../layout/layout-preference.service';
import { DynamicPalette, dynamicAccentTokens } from './dynamic-accent';
import {
  AccentColor,
  DEFAULT_ACCENT_COLOR,
  DEFAULT_THEME_PRESET,
  isAccentColor,
  normalizeThemePreset,
  ThemePreset,
} from '../models';

const DYNAMIC_TOKEN_NAMES = ['--color-accent', '--color-accent-hover', '--color-accent-active', '--color-accent-muted',
  '--color-accent-glow', '--color-text-accent', '--color-accent-fill', '--color-accent-fill-hover', '--color-on-accent'];

export type ThemeSaveState = 'idle' | 'saving' | 'saved' | 'error';

interface ThemeSelection {
  themePreset: ThemePreset;
  accentColor: AccentColor;
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly settingsGateway = inject(SETTINGS_GATEWAY);
  private readonly layoutPreference = inject(LayoutPreferenceService);
  private saveQueue: Promise<void> = Promise.resolve();
  private saveRevision = 0;
  private persistedSelection: ThemeSelection = {
    themePreset: DEFAULT_THEME_PRESET,
    accentColor: DEFAULT_ACCENT_COLOR,
  };

  private readonly themePresetState = signal<ThemePreset>(DEFAULT_THEME_PRESET);
  private readonly accentColorState = signal<AccentColor>(DEFAULT_ACCENT_COLOR);
  private readonly dynamicAccentState = signal(false);
  private readonly paletteState = signal<DynamicPalette | null>(null);
  private readonly saveStateValue = signal<ThemeSaveState>('idle');
  private readonly errorMessageValue = signal<string | null>(null);

  readonly themePreset = this.themePresetState.asReadonly();
  readonly accentColor = this.accentColorState.asReadonly();
  /** Every layout follows the chosen light/dark preset and accent. */
  readonly effectiveTheme = this.themePreset;
  /** The wallpaper accent is chosen; it shows only while the platform supplies a usable palette. */
  readonly dynamicAccent = this.dynamicAccentState.asReadonly();
  readonly dynamicAvailable = computed(() => this.paletteState() !== null);
  /** The wallpaper's mid tone, for the picker swatch. */
  readonly dynamicSwatch = computed(() => this.paletteState()?.[500] ?? null);
  readonly saveState = this.saveStateValue.asReadonly();
  readonly errorMessage = this.errorMessageValue.asReadonly();

  constructor() {
    effect(() => {
      const root = this.document.documentElement;
      const themePreset = this.themePresetState();
      root.setAttribute('data-theme', themePreset);
      const tokens = this.dynamicAccentState() ? this.wallpaperTokens(themePreset) : null;
      root.setAttribute('data-accent', tokens ? 'system' : this.accentColorState());
      for (const [name, value] of Object.entries(tokens ?? {})) root.style.setProperty(name, value);
      if (!tokens) for (const name of DYNAMIC_TOKEN_NAMES) root.style.removeProperty(name);
      // The Android app has its own phone shell; the desktop layouts do not apply there.
      root.setAttribute('data-layout', Capacitor.getPlatform() === 'android' ? 'phone' : this.layoutPreference.mode());
      root.style.colorScheme = themePreset;
    });
  }

  async restore(): Promise<void> {
    try {
      const settings = await this.settingsGateway.getSettings();
      this.persistedSelection = this.normalize(settings.themePreset, settings.accentColor);
      this.dynamicAccentState.set(settings.dynamicAccent === true);
      this.setSelection(this.persistedSelection);
      this.saveStateValue.set('idle');
      this.errorMessageValue.set(null);
    } catch (error) {
      this.persistedSelection = this.normalize(undefined, undefined);
      this.setSelection(this.persistedSelection);
      this.saveStateValue.set('error');
      this.errorMessageValue.set(errorMessage(error, 'Failed to restore appearance settings'));
    }
  }

  setThemePreset(themePreset: ThemePreset): Promise<void> {
    this.themePresetState.set(themePreset);
    return this.persist();
  }

  setAccentColor(accentColor: AccentColor): Promise<void> {
    this.accentColorState.set(accentColor);
    if (this.dynamicAccentState()) void this.setDynamicAccent(false);
    return this.persist();
  }

  /** The platform's wallpaper palette (Android), or null where there is none. */
  setDynamicPalette(palette: DynamicPalette | null): void {
    this.paletteState.set(palette);
  }

  async setDynamicAccent(enabled: boolean): Promise<void> {
    this.dynamicAccentState.set(enabled);
    try { await this.settingsGateway.saveSettings({ dynamicAccent: enabled }); } catch { /* Kept for this session. */ }
  }

  /** Accent tokens from the wallpaper for the preset, measured against the preset's own surfaces. */
  private wallpaperTokens(themePreset: ThemePreset) {
    const palette = this.paletteState();
    if (!palette) return null;
    const root = this.document.documentElement;
    // The effect sets data-theme first, so these are the preset's own surfaces.
    const style = getComputedStyle(root);
    const surfaces = ['--color-canvas', '--color-surface', '--color-surface-elevated']
      .map((name) => style.getPropertyValue(name).trim()).filter((value) => /^#[0-9a-f]{6}$/i.test(value));
    return dynamicAccentTokens(palette, themePreset, surfaces);
  }

  private persist(): Promise<void> {
    const selection = { themePreset: this.themePreset(), accentColor: this.accentColor() };
    const revision = ++this.saveRevision;
    this.saveStateValue.set('saving');
    this.errorMessageValue.set(null);

    this.saveQueue = this.saveQueue.then(async () => {
      try {
        await this.settingsGateway.saveSettings(selection);
        this.persistedSelection = selection;
        if (revision === this.saveRevision) this.saveStateValue.set('saved');
      } catch (error) {
        if (revision === this.saveRevision) {
          this.setSelection(this.persistedSelection);
          this.saveStateValue.set('error');
          this.errorMessageValue.set(errorMessage(error, 'Failed to save appearance settings'));
        }
      }
    });

    return this.saveQueue;
  }

  private setSelection(selection: ThemeSelection): void {
    this.themePresetState.set(selection.themePreset);
    this.accentColorState.set(selection.accentColor);
  }

  private normalize(themePreset: unknown, accentColor: unknown): ThemeSelection {
    return {
      themePreset: normalizeThemePreset(themePreset),
      accentColor: isAccentColor(accentColor) ? accentColor : DEFAULT_ACCENT_COLOR,
    };
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
