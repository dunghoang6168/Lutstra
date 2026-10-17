import { PlayEvent } from '../models';
import { fatigue, HourBucket, hourFactor, ListenerProfile, PRIOR_STRENGTH, priorMean, TrackFacts } from './listener-profile';

export type Random = () => number;

/** What this listening session has shown so far; it steers the picks right away, before the profile learns. */
export interface SessionState {
  artistPlays: Map<string, number>;
  /** Regions skipped early twice in a row: played less until the session ends. */
  coldRegions: Set<string>;
  lastSkippedRegion: string | null;
}

export interface ScoreContext {
  profile: ListenerProfile;
  facts: ReadonlyMap<string, TrackFacts>;
  now: number;
  bucket: HourBucket;
  session: SessionState;
  random: Random;
}

export interface PlanEntry {
  /** The queue entry kept in place; null for a new suggestion. */
  entryId: string | null;
  trackId: string;
  suggested: boolean;
  pinned: boolean;
}

export interface PlanInput {
  /** The queue after the current entry. */
  upcoming: readonly PlanEntry[];
  /** Tracks played just before, up to and including the current one, oldest first. */
  recent: readonly string[];
  /** The user's own tracks played in a row up to the current one. */
  userRun: number;
  /** One suggestion after this many of the user's tracks. */
  every: number;
  /** Suggestions are only placed this far ahead of the current track. */
  window: number;
  /** Rebuild the suggestions after the next track (after a skip). */
  refresh: boolean;
  /** Order the user's unpinned tracks again (Smart Shuffle turned on, tracks added). */
  reorder: boolean;
  /** Tracks not to suggest: already queued, played or removed this session. */
  exclude: ReadonlySet<string>;
}

export const SUGGESTION_WINDOW = 10;
export const DEFAULT_EVERY = 3;
export const MAX_SAME_ARTIST_RUN = 2;

export function newSession(): SessionState {
  return { artistPlays: new Map(), coldRegions: new Set(), lastSkippedRegion: null };
}

/** Records a listen in the session: artist counts, and regions skipped early twice in a row. */
export function updateSession(session: SessionState, event: PlayEvent, track: TrackFacts | undefined): void {
  if (!track) return;
  if (event.playedSeconds > 0) session.artistPlays.set(track.artistKey, (session.artistPlays.get(track.artistKey) ?? 0) + 1);
  const earlySkip = (event.endReason === 'skip_next' || event.endReason === 'removed') && event.playedSeconds < 30;
  if (earlySkip && track.region) {
    if (session.lastSkippedRegion === track.region) session.coldRegions.add(track.region);
    session.lastSkippedRegion = track.region;
  } else if (event.endReason === 'ended') {
    session.lastSkippedRegion = null;
    if (track.region) session.coldRegions.delete(track.region);
  }
}

function normal(random: Random): number {
  return Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
}

/** Marsaglia–Tsang. */
function gamma(shape: number, random: Random): number {
  if (shape < 1) return gamma(shape + 1, random) * (1 - random()) ** (1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(random);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = 1 - random();
    if (Math.log(u) < x * x / 2 + d - d * v + d * Math.log(v)) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, random: Random): number {
  const x = gamma(alpha, random);
  return x / (x + gamma(beta, random));
}

/** How naturally `b` follows `a`: same artist 1, same region 0.6, same genre 0.5, close years 0.3, otherwise 0.15. */
export function relatedness(a: TrackFacts | undefined, b: TrackFacts | undefined): number {
  if (!a || !b) return 0.5;
  if (a.artistKey && a.artistKey === b.artistKey) return 1;
  const matches = [
    a.region && a.region === b.region ? 0.6 : 0,
    a.genre && b.genre && a.genre.toLowerCase() === b.genre.toLowerCase() ? 0.5 : 0,
    a.year && b.year && Math.abs(a.year - b.year) <= 5 ? 0.3 : 0,
  ].filter((value) => value > 0).sort((x, y) => y - x);
  // The strongest link counts in full, each further one adds a little.
  return matches.length ? Math.min(0.95, matches[0] + 0.1 * (matches.length - 1)) : 0.15;
}

const linked = (score: number, related: number) => score * (0.4 + 0.6 * related);

/**
 * Thompson sample of how much the listener would like the track now, times the hour, fatigue and session factors.
 * Fatigue drops a suggestion played in the last day; the user's own tracks keep at least 0.3 of their score.
 */
export function score(track: TrackFacts, context: ScoreContext, suggestion: boolean): number {
  const own = context.profile.tracks.get(track.id);
  const mean = priorMean(track, context.profile);
  const sample = sampleBeta(mean * PRIOR_STRENGTH + (own?.like ?? 0), (1 - mean) * PRIOR_STRENGTH + (own?.dislike ?? 0), context.random);
  const tired = fatigue(track.id, context.profile, context.now);
  const plays = context.session.artistPlays.get(track.artistKey) ?? 0;
  const cold = track.region && context.session.coldRegions.has(track.region) ? 0.5 : 1;
  return sample * hourFactor(track, context.profile, context.bucket) * (suggestion ? tired : Math.max(0.3, tired)) * 0.85 ** plays * cold;
}

/** Would `track` make more than MAX_SAME_ARTIST_RUN in a row by one artist after `recent` (oldest first)? */
export function breaksArtistRun(recent: readonly (TrackFacts | undefined)[], track: TrackFacts): boolean {
  const last = recent.slice(-MAX_SAME_ARTIST_RUN);
  return Boolean(track.artistKey) && last.length === MAX_SAME_ARTIST_RUN && last.every((item) => item?.artistKey === track.artistKey);
}

/**
 * The user's tracks in taste order: each next one has the best sampled score linked to the one before.
 * ponytail: O(n²) greedy; fine for queues of a few thousand tracks.
 */
export function orderByTaste<T extends { trackId: string }>(items: readonly T[], recent: readonly (TrackFacts | undefined)[], context: ScoreContext): T[] {
  const left = items.map((item) => {
    const facts = context.facts.get(item.trackId);
    return { item, facts, score: facts ? score(facts, context, false) : 0 };
  });
  const trail = [...recent];
  const ordered: T[] = [];
  while (left.length) {
    let best = 0;
    let bestValue = -Infinity;
    left.forEach((candidate, index) => {
      if (!candidate.facts) return;
      let value = linked(candidate.score, relatedness(trail.at(-1), candidate.facts));
      if (breaksArtistRun(trail, candidate.facts)) value *= 0.1;
      if (value > bestValue) { bestValue = value; best = index; }
    });
    const [chosen] = left.splice(best, 1);
    ordered.push(chosen.item);
    trail.push(chosen.facts);
  }
  return ordered;
}

/** The best suggestion between `previous` and `next` (a bridge between both), or after `previous` alone. */
export function pickSuggestion(
  previous: TrackFacts | undefined, next: TrackFacts | undefined, recent: readonly (TrackFacts | undefined)[],
  exclude: ReadonlySet<string>, excludeDups: ReadonlySet<string>, context: ScoreContext,
): string | null {
  let best: string | null = null;
  let bestValue = 0;
  for (const track of context.facts.values()) {
    if (exclude.has(track.id) || excludeDups.has(track.dupKey) || breaksArtistRun(recent, track)) continue;
    let value = linked(score(track, context, true), relatedness(previous, track));
    if (next) value *= 0.4 + 0.6 * relatedness(track, next);
    if (value > bestValue) { bestValue = value; best = track.id; }
  }
  return best;
}

/**
 * How many of the user's tracks go between two suggestions, from the last 20 suggestions:
 * mostly skipped early spaces them out (up to 6), mostly played through brings them closer (2).
 */
export function suggestionSpacing(events: readonly PlayEvent[]): number {
  const recent = events.filter((event) => event.source === 'smart-shuffle').slice(-20);
  if (recent.length < 5) return DEFAULT_EVERY;
  const early = recent.filter((event) => event.endReason === 'removed' || (event.endReason !== 'ended' && event.playedSeconds < 30)).length / recent.length;
  const through = recent.filter((event) => event.endReason === 'ended' || (event.duration > 0 && event.playedSeconds / event.duration >= 0.8)).length / recent.length;
  if (early > 0.5) return Math.min(6, DEFAULT_EVERY + Math.ceil((early - 0.5) * 6));
  if (through >= 0.7) return 2;
  return DEFAULT_EVERY;
}

/**
 * The queue after the current entry under Smart Shuffle: the user's tracks (reordered on request,
 * pinned ones in place) with a suggestion after every `every` of them inside the window, and
 * suggestions only once the user's tracks run out, so playback never ends.
 */
export function planUpcoming(input: PlanInput, context: ScoreContext): PlanEntry[] {
  const factsOf = (id: string) => context.facts.get(id);
  // The next entry is already prepared for gapless playback; it moves only when the whole queue is reordered.
  const head = !input.reorder && input.upcoming.length ? [input.upcoming[0]] : [];
  let rest = input.upcoming.slice(head.length);
  // A suggestion the user dragged into place is theirs now, so a fresh plan keeps it.
  if (input.refresh || input.reorder) rest = rest.filter((entry) => !entry.suggested || entry.pinned);

  const trail: (TrackFacts | undefined)[] = input.recent.map(factsOf);
  if (input.reorder) {
    const free = orderByTaste(rest.filter((entry) => !entry.pinned), trail, context);
    let next = 0;
    rest = rest.map((entry) => entry.pinned ? entry : free[next++]);
  }

  const exclude = new Set(input.exclude);
  const dups = new Set<string>();
  for (const id of [...input.recent, ...input.upcoming.map((entry) => entry.trackId)]) {
    exclude.add(id);
    const facts = factsOf(id);
    if (facts) dups.add(facts.dupKey);
  }
  const plan: PlanEntry[] = [];
  let run = input.userRun;
  const place = (entry: PlanEntry) => {
    plan.push(entry);
    trail.push(factsOf(entry.trackId));
    run = entry.suggested ? 0 : run + 1;
  };
  const suggest = (next: TrackFacts | undefined) => {
    const id = pickSuggestion(trail.at(-1), next, trail, exclude, dups, context);
    if (!id) return false;
    exclude.add(id);
    dups.add(factsOf(id)!.dupKey);
    place({ entryId: null, trackId: id, suggested: true, pinned: false });
    return true;
  };

  head.forEach(place);
  for (const entry of rest) {
    if (!entry.suggested && run >= input.every && plan.length < input.window) suggest(factsOf(entry.trackId));
    place(entry);
  }
  while (plan.length < input.window && suggest(undefined)) { /* fill the endless tail */ }
  return plan;
}
