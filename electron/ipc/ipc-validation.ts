import type { MediaControlsInfo } from '../media-controls.js';
import { HISTORY_PAGE_SIZE, HistoryPageRequest, LISTEN_ENDS, LISTEN_SOURCES, LISTEN_STARTS, PlayEvent } from '../../src/app/core/models/index.js';

const ID_PATTERN = /^[a-z]+-[a-f0-9]{64}$/;

export function validId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error('Invalid identifier');
  return value;
}

export function validIdArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Invalid identifier list');
  return value.map(validId);
}

export function validDirectoryPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32767 || value.includes('\0')) {
    throw new Error('Invalid directory path');
  }
  return value;
}

export function validName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 200) throw new Error('Invalid name');
  return value.trim();
}

export function validTitleBarAppearance(value: unknown): 'light' | 'dark' {
  if (value !== 'light' && value !== 'dark') throw new Error('Invalid title bar appearance');
  return value;
}

export function validMusicBrainzId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid MusicBrainz identifier');
  return value.toLowerCase();
}

export function validWikipediaOverride(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error('Invalid Wikipedia URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['en.wikipedia.org', 'vi.wikipedia.org'].includes(url.hostname) || !url.pathname.startsWith('/wiki/')) throw new Error('Invalid Wikipedia URL');
  return url.toString();
}

export function validArtistSourceUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid source URL');
  const url = new URL(value);
  const allowed = url.hostname === 'musicbrainz.org' || url.hostname === 'en.wikipedia.org' || url.hostname === 'vi.wikipedia.org' || url.hostname === 'www.wikidata.org' || url.hostname === 'www.theaudiodb.com';
  if (url.protocol !== 'https:' || !allowed) throw new Error('Untrusted source URL');
  return url.toString();
}

export function validOutputMode(value: unknown): 'shared' | 'exclusive-dsp' {
  if (value !== 'shared' && value !== 'exclusive-dsp') throw new Error('Invalid audio output mode');
  return value;
}

export function validExclusiveBufferMs(value: unknown): number {
  if (typeof value !== 'number' || ![10,20,40,80].includes(value)) throw new Error('Invalid Exclusive buffer');
  return value;
}

export function validMediaControlsInfo(value: unknown, resolveArtworkPath: (hash: string) => string | null): MediaControlsInfo {
  const info = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const state = info['state'];
  if (state !== 'playing' && state !== 'paused' && state !== 'none') throw new Error('Invalid media controls state');
  const text = (field: unknown) => typeof field === 'string' ? field.slice(0, 512) : '';
  // Only the app's own artwork URLs resolve to a file; the renderer never sends a raw path.
  const hash = typeof info['artwork'] === 'string' ? /^music:\/\/artwork\/([a-f0-9]{64})$/.exec(info['artwork'])?.[1] : undefined;
  return {
    title: text(info['title']), artist: text(info['artist']), album: text(info['album']), state,
    artworkPath: hash ? resolveArtworkPath(hash) : null,
  };
}

const DAY_SECONDS = 60 * 60 * 24;

export function validPlayEvent(value: unknown): PlayEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid listen');
  const event = value as Record<string, unknown>;
  const seconds = (name: string) => {
    const number = event[name];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > DAY_SECONDS) throw new Error(`Invalid listen ${name}`);
    return number;
  };
  const oneOf = <T extends string>(name: string, values: readonly T[]): T => {
    if (!values.includes(event[name] as T)) throw new Error(`Invalid listen ${name}`);
    return event[name] as T;
  };
  const startedAt = event['startedAt'];
  if (typeof startedAt !== 'number' || !Number.isSafeInteger(startedAt) || startedAt <= 0) throw new Error('Invalid listen startedAt');
  return {
    trackId: validId(event['trackId']), startedAt, playedSeconds: seconds('playedSeconds'), endPosition: seconds('endPosition'),
    duration: seconds('duration'), seekForwardSeconds: seconds('seekForwardSeconds'), startedBy: oneOf('startedBy', LISTEN_STARTS),
    endReason: oneOf('endReason', LISTEN_ENDS), source: oneOf('source', LISTEN_SOURCES),
  };
}

export function validHistoryPageRequest(value: unknown): HistoryPageRequest {
  if (!value || typeof value !== 'object') throw new Error('Invalid history request');
  const request = value as Record<string, unknown>;
  const limit = request['limit'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > HISTORY_PAGE_SIZE) throw new Error('Invalid history limit');
  const before = request['before'];
  if (before === undefined) return { limit };
  const cursor = before as Record<string, unknown> | null;
  if (!cursor || typeof cursor !== 'object' || !Number.isSafeInteger(cursor['startedAt']) || !Number.isSafeInteger(cursor['id'])) throw new Error('Invalid history cursor');
  return { limit, before: { startedAt: cursor['startedAt'] as number, id: cursor['id'] as number } };
}
