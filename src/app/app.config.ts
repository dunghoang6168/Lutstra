import { ApplicationConfig, inject, InjectionToken, NgZone, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { phoneRoutes } from './phone/phone.routes';
import { ARTIST_METADATA_GATEWAY, AUDIO_ANALYSIS_ENGINE, AudioAnalysisEngine, LIBRARY_GATEWAY, LISTENING_HISTORY_GATEWAY, LYRICS_GATEWAY, PLAYBACK_ENGINE, PlaybackEngine, PLAYLIST_GATEWAY, POPULARITY_GATEWAY, SETTINGS_GATEWAY } from './core/contracts';
import { MockArtistMetadataGateway, MockLibraryGateway, MockListeningHistoryGateway, MockLyricsGateway, MockPlaybackEngine, MockPopularityGateway, MockPlaylistGateway, MockSettingsGateway } from './core/mock';
import { ElectronLibraryGateway } from './core/desktop/electron-library.gateway';
import { ElectronPlaylistGateway } from './core/desktop/electron-playlist.gateway';
import { ElectronSettingsGateway } from './core/desktop/electron-settings.gateway';
import { ElectronArtistMetadataGateway } from './core/desktop/electron-artist-metadata.gateway';
import { ElectronLyricsGateway } from './core/desktop/electron-lyrics.gateway';
import { ElectronPopularityGateway } from './core/desktop/electron-popularity.gateway';
import { ElectronListeningHistoryGateway } from './core/desktop/electron-listening-history.gateway';
import { HtmlAudioPlaybackEngine } from './core/desktop/html-audio-playback.engine';
import { NativeAudioPlaybackEngine } from './core/desktop/native-audio-playback.engine';
import { SwitchingPlaybackEngine } from './core/desktop/switching-playback.engine';
import { getDesktopApi } from './core/desktop/desktop-api';
import { ThemeService } from './core/theme/theme.service';
import { MediaSessionService } from './core/media/media-session.service';
import { LayoutPreferenceService } from './core/layout/layout-preference.service';
import { AudioVisualizationPreferenceService } from './core/layout/audio-visualization-preference.service';
import { ListeningHistoryService } from './core/history/listening-history.service';
import { SmartShuffleService } from './core/smart-shuffle/smart-shuffle.service';
import { Capacitor } from '@capacitor/core';
import { AndroidLibraryGateway } from './core/android/android-library.gateway';
import { AndroidPlaylistGateway } from './core/android/android-playlist.gateway';
import { AndroidPlaybackEngine } from './core/android/android-playback.engine';
import { AndroidSettingsGateway } from './core/android/android-settings.gateway';
import { AndroidListeningHistoryGateway } from './core/android/android-listening-history.gateway';

const isDesktop = () => Boolean(getDesktopApi());
const isAndroid = () => Capacitor.getPlatform() === 'android';
const ACTIVE_AUDIO_ENGINE = new InjectionToken<PlaybackEngine & AudioAnalysisEngine>('ACTIVE_AUDIO_ENGINE');

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(isAndroid() ? phoneRoutes : routes),

    { provide: LIBRARY_GATEWAY, useFactory: () => isDesktop() ? new ElectronLibraryGateway() : isAndroid() ? new AndroidLibraryGateway(inject(NgZone)) : new MockLibraryGateway() },
    { provide: PLAYLIST_GATEWAY, useFactory: () => isDesktop() ? new ElectronPlaylistGateway() : isAndroid() ? new AndroidPlaylistGateway() : new MockPlaylistGateway() },
    { provide: SETTINGS_GATEWAY, useFactory: () => isDesktop() ? new ElectronSettingsGateway() : isAndroid() ? new AndroidSettingsGateway() : new MockSettingsGateway() },
    { provide: ARTIST_METADATA_GATEWAY, useFactory: () => isDesktop() ? new ElectronArtistMetadataGateway() : new MockArtistMetadataGateway() },
    { provide: LYRICS_GATEWAY, useFactory: () => isDesktop() ? new ElectronLyricsGateway() : new MockLyricsGateway() },
    { provide: POPULARITY_GATEWAY, useFactory: () => isDesktop() ? new ElectronPopularityGateway() : new MockPopularityGateway() },
    { provide: LISTENING_HISTORY_GATEWAY, useFactory: () => isDesktop() ? new ElectronListeningHistoryGateway() : isAndroid() ? new AndroidListeningHistoryGateway() : new MockListeningHistoryGateway() },
    { provide: ACTIVE_AUDIO_ENGINE, useFactory: () => isDesktop()
      ? new SwitchingPlaybackEngine(new HtmlAudioPlaybackEngine(), new NativeAudioPlaybackEngine(inject(NgZone)))
      : isAndroid() ? new AndroidPlaybackEngine(inject(NgZone)) : new MockPlaybackEngine() },
    { provide: PLAYBACK_ENGINE, useExisting: ACTIVE_AUDIO_ENGINE },
    { provide: AUDIO_ANALYSIS_ENGINE, useExisting: ACTIVE_AUDIO_ENGINE },
    provideAppInitializer(() => inject(ThemeService).restore()),
    provideAppInitializer(() => inject(LayoutPreferenceService).restore()),
    provideAppInitializer(() => inject(AudioVisualizationPreferenceService).restore()),
    provideAppInitializer(() => void inject(MediaSessionService)),
    provideAppInitializer(() => void inject(ListeningHistoryService)),
    provideAppInitializer(() => void inject(SmartShuffleService)),
  ],
};
