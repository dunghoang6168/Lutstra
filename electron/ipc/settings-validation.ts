import { validOutputMode, validExclusiveBufferMs, validIdArray } from './ipc-validation.js';
import { isAccentColor, isAddTracksTab, isAudioVisualizationMode, isLayoutMode, isSongColumn, isSongColumnOrder, isThemePreset, type PlaybackSession } from '../../src/app/core/models/index.js';

export function validSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid settings');
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if ('defaultVolume' in input) { if (typeof input['defaultVolume'] !== 'number') throw new Error('Invalid volume'); result['defaultVolume'] = input['defaultVolume']; }
  if ('repeatMode' in input) { if (!['off','one','all'].includes(String(input['repeatMode']))) throw new Error('Invalid repeat mode'); result['repeatMode'] = input['repeatMode']; }
  if ('shuffle' in input) { if (typeof input['shuffle'] !== 'boolean') throw new Error('Invalid shuffle setting'); result['shuffle'] = input['shuffle']; }
  if ('smartShuffle' in input) { if (typeof input['smartShuffle'] !== 'boolean') throw new Error('Invalid smart shuffle setting'); result['smartShuffle'] = input['smartShuffle']; }
  if ('autoplay' in input) { if (typeof input['autoplay'] !== 'boolean') throw new Error('Invalid autoplay setting'); result['autoplay'] = input['autoplay']; }
  if ('crossfadeEnabled' in input) { if (typeof input['crossfadeEnabled'] !== 'boolean') throw new Error('Invalid crossfade setting'); result['crossfadeEnabled'] = input['crossfadeEnabled']; }
  if ('crossfadeSeconds' in input) { if (typeof input['crossfadeSeconds'] !== 'number' || !Number.isInteger(input['crossfadeSeconds']) || input['crossfadeSeconds'] < 1 || input['crossfadeSeconds'] > 12) throw new Error('Invalid crossfade duration'); result['crossfadeSeconds'] = input['crossfadeSeconds']; }
  if ('audioEngineBackend' in input) { if (!['chromium','native-shared'].includes(String(input['audioEngineBackend']))) throw new Error('Invalid audio engine backend'); result['audioEngineBackend'] = input['audioEngineBackend']; }
  if ('preferredAudioOutputId' in input) { if (typeof input['preferredAudioOutputId'] !== 'string' || input['preferredAudioOutputId'].length < 1 || input['preferredAudioOutputId'].length > 512) throw new Error('Invalid audio output ID'); result['preferredAudioOutputId'] = input['preferredAudioOutputId']; }
  if ('preferredAudioOutputName' in input) { if (typeof input['preferredAudioOutputName'] !== 'string' || input['preferredAudioOutputName'].length > 256) throw new Error('Invalid audio output name'); result['preferredAudioOutputName'] = input['preferredAudioOutputName']; }
  if ('preferredNativeAudioOutputId' in input) { if (typeof input['preferredNativeAudioOutputId'] !== 'string' || input['preferredNativeAudioOutputId'].length < 1 || input['preferredNativeAudioOutputId'].length > 512) throw new Error('Invalid native audio output ID'); result['preferredNativeAudioOutputId'] = input['preferredNativeAudioOutputId']; }
  if ('preferredNativeAudioOutputName' in input) { if (typeof input['preferredNativeAudioOutputName'] !== 'string' || input['preferredNativeAudioOutputName'].length > 256) throw new Error('Invalid native audio output name'); result['preferredNativeAudioOutputName'] = input['preferredNativeAudioOutputName']; }
  if ('outputMode' in input) result['outputMode'] = validOutputMode(input['outputMode']);
  if ('exclusiveBufferMs' in input) result['exclusiveBufferMs'] = validExclusiveBufferMs(input['exclusiveBufferMs']);
  if ('audioOutputFallbackEnabled' in input) { if (typeof input['audioOutputFallbackEnabled'] !== 'boolean') throw new Error('Invalid audio fallback setting'); result['audioOutputFallbackEnabled'] = input['audioOutputFallbackEnabled']; }
  if ('themePreset' in input) { if (!isThemePreset(input['themePreset'])) throw new Error('Invalid theme preset'); result['themePreset'] = input['themePreset']; }
  if ('accentColor' in input) { if (!isAccentColor(input['accentColor'])) throw new Error('Invalid accent color'); result['accentColor'] = input['accentColor']; }
  if ('liquidGlassAccentColor' in input) { if (!isAccentColor(input['liquidGlassAccentColor'])) throw new Error('Invalid Liquid Glass accent color'); result['liquidGlassAccentColor'] = input['liquidGlassAccentColor']; }
  if ('layoutMode' in input) { if (!isLayoutMode(input['layoutMode'])) throw new Error('Invalid layout mode'); result['layoutMode'] = input['layoutMode']; }
  if ('audioVisualizationMode' in input) { if (!isAudioVisualizationMode(input['audioVisualizationMode'])) throw new Error('Invalid audio visualization mode'); result['audioVisualizationMode'] = input['audioVisualizationMode']; }
  if ('ambientArtwork' in input) { if (typeof input['ambientArtwork'] !== 'boolean') throw new Error('Invalid Ambient artwork setting'); result['ambientArtwork'] = input['ambientArtwork']; }
  if ('addTracksTab' in input) { if (!isAddTracksTab(input['addTracksTab'])) throw new Error('Invalid Add tracks tab'); result['addTracksTab'] = input['addTracksTab']; }
  if ('hiddenSongColumns' in input) {
    const columns = input['hiddenSongColumns'];
    if (!Array.isArray(columns) || !columns.every(isSongColumn)) throw new Error('Invalid Songs columns');
    result['hiddenSongColumns'] = [...new Set(columns)];
  }
  if ('songColumnOrder' in input) {
    if (!isSongColumnOrder(input['songColumnOrder'])) throw new Error('Invalid Songs column order');
    result['songColumnOrder'] = [...input['songColumnOrder']];
  }
  return result;
}

export function validPlaybackSession(value: unknown): PlaybackSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid playback session');
  const input = value as Record<string, unknown>;
  const trackIds = validIdArray(input['trackIds']);
  const order = input['originalOrder'];
  if (!Array.isArray(order) || order.length !== trackIds.length || new Set(order).size !== order.length
    || !order.every((index) => Number.isInteger(index) && index >= 0 && index < trackIds.length)) throw new Error('Invalid playback session order');
  const currentIndex = input['currentIndex'];
  if (!Number.isInteger(currentIndex) || (currentIndex as number) < -1 || (currentIndex as number) >= trackIds.length) throw new Error('Invalid playback session index');
  const position = input['positionSeconds'];
  if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) throw new Error('Invalid playback session position');
  const suggested = input['suggested'];
  if (suggested !== undefined && (!Array.isArray(suggested) || new Set(suggested).size !== suggested.length
    || !suggested.every((index) => Number.isInteger(index) && index >= 0 && index < trackIds.length))) throw new Error('Invalid playback session suggestions');
  const session = { trackIds, originalOrder: [...order], currentIndex: currentIndex as number, positionSeconds: position };
  return suggested === undefined ? { version: 1, ...session } : { version: 2, ...session, suggested: [...suggested] };
}
