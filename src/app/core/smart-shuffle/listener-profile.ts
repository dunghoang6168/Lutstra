import { PlayEvent } from '../models';

/** What Smart Shuffle knows about a track besides its listens. */
export interface TrackFacts {
  id: string;
  /** Normalized title and lead artist, to spot the same recording twice. */
  dupKey: string;
  artistKey: string;
  region: string | null;
  genre: string | null;
  year: number | null;
  /** When the file appeared in the library (its last-modified time), ms. */
  addedAt: number | null;
  inPlaylist: boolean;
  /** Online popularity as a percentile within the library, 0–1; null when unknown. */
  popularity: number | null;
}

export interface Tally {
  like: number;
  dislike: number;
}

export interface ListenerProfile {
  tracks: Map<string, Tally>;
  /** `artist:…`, `region:…`, `genre:…`, `decade:…` */
  groups: Map<string, Tally>;
  /** `<hour bucket>|<artist or region group>` */
  hours: Map<string, Tally>;
  /** Start of the latest real listen per track, ms. */
  lastPlayed: Map<string, number>;
  /** Decayed number of listens with a signal; fades the cold-start prior out. */
  weight: number;
  /** Library shape for the cold start: share of tracks per artist and region, the largest being 1. */
  artistShare: Map<string, number>;
  regionShare: Map<string, number>;
  newestAdded: number;
}

export type HourBucket = 'morning' | 'afternoon' | 'evening' | 'night';
type GroupKind = 'artist' | 'region' | 'genre' | 'decade';

export const HALF_LIFE_DAYS = 60;
const DAY_MS = 86_400_000;
/** How much the artist, region, genre and decade preferences count towards a track's prior. */
const GROUP_WEIGHTS: Readonly<Record<GroupKind, number>> = { artist: 0.4, region: 0.3, genre: 0.2, decade: 0.1 };
/** Strength of the prior in listens: a track's own history outweighs its groups after a few plays. */
export const PRIOR_STRENGTH = 3;
/** Listens (decayed) after which the cold-start prior has faded to half. */
const COLD_FADE_LISTENS = 30;
const RECENT_ADD_DAYS = 90;

const normalize = (value: string | null | undefined) => (value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** First credited artist of the album artist (or artist), lower-cased: feat. guests do not make a new artist. */
export function artistKey(albumArtist: string | null, artist: string | null): string {
  return normalize((albumArtist || artist || '').split(/\s*(?:,|&|\/|;|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0]);
}

/** Same song, another file: title without bracketed remaster notes, plus the lead artist. */
export function dupKey(title: string, albumArtist: string | null, artist: string | null): string {
  return normalize(title.replace(/\s*[([][^)\]]*(?:remaster|version|edit|mono|stereo)[^)\]]*[)\]]/gi, '')) + '|' + artistKey(albumArtist, artist);
}

export function groupKeys(facts: TrackFacts): Array<[GroupKind, string]> {
  const keys: Array<[GroupKind, string]> = [];
  if (facts.artistKey) keys.push(['artist', 'artist:' + facts.artistKey]);
  if (facts.region) keys.push(['region', 'region:' + facts.region]);
  if (facts.genre) keys.push(['genre', 'genre:' + normalize(facts.genre)]);
  if (facts.year) keys.push(['decade', 'decade:' + Math.floor(facts.year / 10) * 10]);
  return keys;
}

export function hourBucket(time: number): HourBucket {
  const hour = new Date(time).getHours();
  return hour >= 5 && hour < 11 ? 'morning' : hour >= 11 && hour < 17 ? 'afternoon' : hour >= 17 && hour < 22 ? 'evening' : 'night';
}

/** What one listen says about the track; null when it says nothing (the app closed, a failure, going back). */
export function signalOf(event: PlayEvent): Tally | null {
  if (event.endReason === 'removed') return { like: 0, dislike: 0.5 };
  if (event.endReason === 'app_closed' || event.endReason === 'other' || event.endReason === 'skip_previous') return null;
  const through = event.endReason === 'ended' || (event.duration > 0 && event.playedSeconds / event.duration >= 0.8);
  if (through) {
    const like = event.startedBy === 'user' ? 1.5 : 1;
    // Played to the end by skimming: still a pick, but not much of a listen.
    return event.duration > 0 && event.seekForwardSeconds > event.duration / 2 ? { like: like / 2, dislike: 0.3 } : { like, dislike: 0 };
  }
  if (event.endReason === 'picked_other') return { like: 0, dislike: event.playedSeconds < 30 ? 0.5 : 0.2 };
  return { like: 0, dislike: event.playedSeconds < 30 ? 1 : 0.3 };
}

const add = (map: Map<string, Tally>, key: string, signal: Tally, weight: number) => {
  const tally = map.get(key) ?? { like: 0, dislike: 0 };
  tally.like += signal.like * weight;
  tally.dislike += signal.dislike * weight;
  map.set(key, tally);
};

/** A fresh profile from the library alone; listens are added with `addListen`. */
export function emptyProfile(facts: ReadonlyMap<string, TrackFacts>): ListenerProfile {
  const share = (key: (track: TrackFacts) => string | null) => {
    const counts = new Map<string, number>();
    for (const track of facts.values()) {
      const value = key(track);
      if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    const largest = Math.max(1, ...counts.values());
    return new Map([...counts].map(([value, count]) => [value, count / largest]));
  };
  return {
    tracks: new Map(), groups: new Map(), hours: new Map(), lastPlayed: new Map(), weight: 0,
    artistShare: share((track) => track.artistKey || null), regionShare: share((track) => track.region),
    newestAdded: Math.max(0, ...[...facts.values()].map((track) => track.addedAt ?? 0)),
  };
}

/** Adds one listen, weighted by its age (`HALF_LIFE_DAYS`). */
export function addListen(profile: ListenerProfile, event: PlayEvent, facts: ReadonlyMap<string, TrackFacts>, now: number): void {
  if (event.playedSeconds > 0) profile.lastPlayed.set(event.trackId, Math.max(profile.lastPlayed.get(event.trackId) ?? 0, event.startedAt));
  const signal = signalOf(event);
  if (!signal) return;
  const weight = 0.5 ** (Math.max(0, now - event.startedAt) / DAY_MS / HALF_LIFE_DAYS);
  profile.weight += weight;
  add(profile.tracks, event.trackId, signal, weight);
  const track = facts.get(event.trackId);
  if (!track) return;
  const bucket = hourBucket(event.startedAt);
  for (const [kind, key] of groupKeys(track)) {
    add(profile.groups, key, signal, weight);
    if (kind === 'artist' || kind === 'region') add(profile.hours, bucket + '|' + key, signal, weight);
  }
}

export function buildProfile(events: readonly PlayEvent[], facts: ReadonlyMap<string, TrackFacts>, now: number): ListenerProfile {
  const profile = emptyProfile(facts);
  for (const event of events) addListen(profile, event, facts, now);
  return profile;
}

/** Laplace-smoothed share of likes. */
export function preference(tally: Tally | undefined): number {
  return tally ? (tally.like + 1) / (tally.like + tally.dislike + 2) : 0.5;
}

/** Guess for a track nobody has listened to yet: what the library says the listener collects. */
export function coldPrior(track: TrackFacts, profile: ListenerProfile): number {
  const recent = track.addedAt && profile.newestAdded
    ? Math.max(0, 1 - (profile.newestAdded - track.addedAt) / (RECENT_ADD_DAYS * DAY_MS)) : 0;
  const value = 0.35 + 0.2 * (profile.artistShare.get(track.artistKey) ?? 0) + 0.15 * (track.region ? profile.regionShare.get(track.region) ?? 0 : 0)
    + 0.15 * recent + 0.1 * (track.inPlaylist ? 1 : 0) + 0.05 * (track.popularity ?? 0.5);
  return Math.min(0.95, Math.max(0.05, value));
}

/** Expected chance the listener likes the track before its own listens: its groups, blended with the cold start. */
export function priorMean(track: TrackFacts, profile: ListenerProfile): number {
  let sum = 0;
  let weights = 0;
  for (const [kind, key] of groupKeys(track)) {
    const tally = profile.groups.get(key);
    if (!tally) continue;
    const count = tally.like + tally.dislike;
    const weight = GROUP_WEIGHTS[kind] * count / (count + 2);
    sum += weight * preference(tally);
    weights += weight;
  }
  const learned = weights > 0 ? sum / weights : 0.5;
  const fade = 1 / (1 + profile.weight / COLD_FADE_LISTENS);
  return fade * coldPrior(track, profile) + (1 - fade) * learned;
}

/** The listener's habits at this time of day for the track's artist and region, 0.7–1.3; 1 without enough listens. */
export function hourFactor(track: TrackFacts, profile: ListenerProfile, bucket: HourBucket): number {
  let factor = 1;
  for (const [kind, key] of groupKeys(track)) {
    if (kind !== 'artist' && kind !== 'region') continue;
    const tally = profile.hours.get(bucket + '|' + key);
    if (tally && tally.like + tally.dislike >= 3) factor *= 0.7 + 0.6 * preference(tally);
  }
  return factor;
}

/** 0 within a day of the last listen, then back to 1 over the following six days. */
export function fatigue(trackId: string, profile: ListenerProfile, now: number): number {
  const last = profile.lastPlayed.get(trackId);
  if (!last) return 1;
  const hours = (now - last) / 3_600_000;
  return hours < 24 ? 0 : Math.min(1, 0.3 + 0.7 * (hours - 24) / (6 * 24));
}
