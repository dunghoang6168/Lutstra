import type { FolderNode } from '../../core/models/folder.model';

/** 1 base, 2 blue, 3 red, 4 gold, 5 mythical. */
export type RarityTier = 1 | 2 | 3 | 4 | 5;
/** Tiers with their own share and rate; mythical is carved out of the gold share and the gold roll. */
type BaseTier = Exclude<RarityTier, 5>;

/** Share of a region's tracks in each tier, by YouTube views: the most viewed 10% are gold or mythical. */
export const TIER_SHARES: Readonly<Record<BaseTier, number>> = { 1: 0.4, 2: 0.3, 3: 0.2, 4: 0.1 };
/** The most viewed 2% of a region are mythical, whoever the artist. */
export const MYTHIC_SHARE = 0.02;
/** Gold holds at most this many tracks per artist; the rest drop to red, so one artist cannot fill it. */
export const GOLD_PER_ARTIST = 2;
/** Region folders too small or mixed for their own scale; they rank against the whole library. */
export const RANKED_WITH_LIBRARY: ReadonlySet<string> = new Set(['Random ass']);

export interface RankedTrack {
  id: string;
  region: string;
  /** First credited artist, from `leadArtist()`. */
  artist: string;
  views: number | null;
}

/** First credited artist, as the YouTube search uses it (`electron/utils/youtube-match.ts`). */
export function leadArtist(artist: string | null): string {
  return artist?.split(/\s*(?:,|&|\/|;|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0]?.trim() ?? '';
}

/**
 * Case-opening rarity from YouTube views (developer mode), ranked within each region, since view
 * counts differ by an order of magnitude between regions (VN median 1.9M, KOR 32.6M). The top
 * MYTHIC_SHARE is mythical; gold takes the rest of the top 10% but GOLD_PER_ARTIST at most per artist.
 * Tracks without views (no match, not fetched yet) are left out of the ranking and the map; they roll as base.
 */
export function popularityTiers(tracks: readonly RankedTrack[]): Map<string, RarityTier> {
  const scaleOf = (region: string) => RANKED_WITH_LIBRARY.has(region) ? null : region;
  // The null scale is the whole library.
  const scales = new Map<string | null, number[]>();
  for (const track of tracks) {
    if (track.views == null) continue;
    for (const key of new Set([null, scaleOf(track.region)])) {
      if (!scales.has(key)) scales.set(key, []);
      scales.get(key)!.push(track.views);
    }
  }
  // Minimum views for mythical, gold, red and blue on each scale; Infinity when a tier rounds to no tracks.
  const cuts = new Map([...scales].map(([key, views]) => {
    views.sort((a, b) => b - a);
    const at = (share: number) => {
      const count = Math.round(views.length * share);
      return count > 0 ? views[count - 1] : Infinity;
    };
    let share = 0;
    return [key, [at(MYTHIC_SHARE), ...([4, 3, 2] as const).map((tier) => at(share += TIER_SHARES[tier]))]];
  }));
  const tiers = new Map<string, RarityTier>();
  // Most viewed first, so an artist's gold places go to its biggest tracks.
  const goldCount = new Map<string, number>();
  const ranked = tracks.filter((track): track is RankedTrack & { views: number } => track.views != null);
  for (const { id, region, artist, views } of ranked.sort((a, b) => b.views - a.views)) {
    const [mythic, gold, red, blue] = cuts.get(scaleOf(region))!;
    if (views >= gold && views < mythic) {
      const key = `${scaleOf(region)}\n${artist}`;
      goldCount.set(key, (goldCount.get(key) ?? 0) + 1);
      tiers.set(id, goldCount.get(key)! <= GOLD_PER_ARTIST ? 4 : 3);
      continue;
    }
    tiers.set(id, views >= mythic ? 5 : views >= red ? 3 : views >= blue ? 2 : 1);
  }
  return tiers;
}

/** Region of each track: the top-level folder under its music root, or the root itself for files directly in it. */
export function trackRegions(roots: readonly FolderNode[]): Map<string, string> {
  const regions = new Map<string, string>();
  for (const root of roots) {
    for (const child of root.children ?? []) {
      const ids = child.isFolder ? collectTrackIds(child, true) : child.trackId ? [child.trackId] : [];
      for (const id of ids) regions.set(id, child.isFolder ? child.name : root.name);
    }
  }
  return regions;
}

export function listFolders(roots: FolderNode[]): FolderNode[] {
  const folders: FolderNode[] = [];
  for (const node of roots) {
    if (!node.isFolder) continue;
    folders.push(node, ...listFolders(node.children ?? []));
  }
  return folders;
}

export function collectTrackIds(folder: FolderNode, recursive: boolean): string[] {
  if (!folder.isFolder) return [];
  const ids: string[] = [];
  for (const child of folder.children ?? []) {
    if (child.isFolder) {
      if (recursive) ids.push(...collectTrackIds(child, true));
    } else if (child.trackId) {
      ids.push(child.trackId);
    }
  }
  return [...new Set(ids)];
}

/** Track ids of several sources, without repeats: a ticked folder may sit inside another ticked folder. */
export function sourceTrackIds(sources: readonly FolderNode[], recursive: boolean): string[] {
  return [...new Set(sources.flatMap((source) => collectTrackIds(source, recursive)))];
}

export function pickRandom<T>(items: readonly T[], random: () => number = Math.random): T | null {
  if (!items.length) return null;
  return items[Math.floor(random() * items.length)];
}

export const REEL_LENGTH = 60;
export const REEL_WINNER_INDEX = 52;
/** Largest stop offset from the winner's centre, as a fraction of a cell width. */
export const REEL_MAX_OFFSET = 0.35;

export interface Reel<T> {
  items: T[];
  winnerIndex: number;
  /** Where the pointer lands inside the winning cell, in cell widths from its centre. */
  offset: number;
}

/** Builds a case-opening reel: filler from `fill()`, with the pick at a fixed slot. */
export function buildReel<T>(fill: () => T, pick: T, random: () => number = Math.random): Reel<T> {
  const items = Array.from({ length: REEL_LENGTH }, (_, i) => i === REEL_WINNER_INDEX ? pick : fill());
  return { items, winnerIndex: REEL_WINNER_INDEX, offset: (random() * 2 - 1) * REEL_MAX_OFFSET };
}

// Gacha rates per rarity tier (1 base … 4 gold), like an anime gacha banner. The gold rate is the
// rate of a top roll, which a MYTHIC_CHANCE coin flip (or the mythic guarantee) upgrades to mythical.
export const RARITY_RATES: Readonly<Record<BaseTier, number>> = { 1: 0.65, 2: 0.25, 3: 0.085, 4: 0.015 };
export const RARITY_NAMES: Readonly<Record<RarityTier, string>> = { 1: 'Base', 2: 'Blue', 3: 'Red', 4: 'Gold', 5: 'Mythical' };
export const MYTHIC_CHANCE = 0.25;
/** This top roll since the last mythical is always mythical. */
export const MYTHIC_GUARANTEE = 3;
/** From this roll since the last gold, every roll adds SOFT_PITY_STEP to the gold rate. */
export const SOFT_PITY_FROM = 40;
export const SOFT_PITY_STEP = 0.06;
/** This roll since the last gold is always gold. */
export const HARD_PITY = 50;
/** At least one red-or-better in this many rolls. */
export const RED_PITY = 10;
const TIERS: readonly BaseTier[] = [1, 2, 3, 4];

/** Rolls since the last gold-or-better, since the last red-or-better, and golds since the last mythical. */
export interface Pity {
  gold: number;
  red: number;
  mythic: number;
}

/** Tracks per tier. */
export type TierCounts = Record<RarityTier, number>;

export function tierCounts(tiers: Iterable<RarityTier>): TierCounts {
  const counts: TierCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const tier of tiers) counts[tier]++;
  return counts;
}

/**
 * Scales the listed rates by how a source's tiers compare with the whole library's: a folder of
 * mostly mythical hits rolls mythical more often, instead of handing its one base track the base
 * 65%. A source shaped like the library rolls at the listed rates.
 */
export interface RateScale {
  pool: TierCounts;
  library: TierCounts;
}

/** Gold rate for the nth roll since the last gold. */
export function goldRate(roll: number): number {
  if (roll >= HARD_PITY) return 1;
  if (roll >= SOFT_PITY_FROM) return RARITY_RATES[4] + SOFT_PITY_STEP * (roll - SOFT_PITY_FROM + 1);
  return RARITY_RATES[4];
}

/**
 * Rolls a tier with pity. A tier with no tracks hands its rate to the nearest available tier below
 * (or above, when nothing is below). Counters stop one short of their guarantee, so a guarantee the
 * source cannot pay out fires as soon as a source with that tier is rolled. Gold and mythical share
 * the top roll; it is mythical on a MYTHIC_CHANCE flip, on the MYTHIC_GUARANTEE-th top roll, or
 * when the source has no gold.
 */
export function rollTier(
  pity: Pity, available: ReadonlySet<RarityTier>, random: () => number = Math.random, scale?: RateScale,
): { tier: RarityTier; pity: Pity } | null {
  if (!available.size) return null;
  const has = new Set<BaseTier>([...available].map((tier) => tier === 5 ? 4 : tier));
  // Pity only lifts a tier the source actually has; otherwise a full counter would turn every
  // later roll into the fallback tier.
  const gold = has.has(4) ? goldRate(pity.gold + 1) : RARITY_RATES[4];
  const redGuaranteed = pity.red + 1 >= RED_PITY && has.has(3);
  // Extra gold comes out of the base tier first, then blue, then red.
  const rest = 1 - gold;
  const red = redGuaranteed ? rest : Math.min(RARITY_RATES[3], rest);
  const blue = redGuaranteed ? 0 : Math.min(RARITY_RATES[2], rest - red);
  const weights: Record<BaseTier, number> = { 1: rest - red - blue, 2: blue, 3: red, 4: gold };
  if (scale) {
    // Each tier's weight times its share of the source over its share of the library; gold and
    // mythical count as one top tier. Absent tiers end at 0, so nothing is handed down below.
    const top = (counts: TierCounts) => counts[4] + counts[5];
    const share = (counts: TierCounts, tier: BaseTier) => tier === 4 ? top(counts) : counts[tier];
    const scaled = TIERS.map((tier) => {
      const library = share(scale.library, tier);
      return weights[tier] * (library ? share(scale.pool, tier) / library : 0);
    });
    // Library counts missing or stale (nothing left to roll): keep the listed rates.
    if (scaled.some((weight) => weight > 0)) TIERS.forEach((tier, i) => weights[tier] = scaled[i]);
  }
  for (const tier of [...TIERS].reverse()) {
    if (has.has(tier) || !weights[tier]) continue;
    const target = [...TIERS].reverse().find((t) => t < tier && has.has(t)) ?? TIERS.find((t) => t > tier && has.has(t))!;
    weights[target] += weights[tier];
    weights[tier] = 0;
  }
  let point = random() * TIERS.reduce((sum, t) => sum + weights[t], 0);
  const rolled = TIERS.find((t) => (point -= weights[t]) < 0 && weights[t] > 0) ?? [...TIERS].reverse().find((t) => weights[t] > 0)!;
  let tier: RarityTier = rolled;
  let mythic = pity.mythic;
  if (rolled === 4) {
    const mythical = available.has(5) && (!available.has(4) || mythic + 1 >= MYTHIC_GUARANTEE || random() < mythicChance(scale));
    tier = mythical ? 5 : 4;
    mythic = mythical ? 0 : Math.min(mythic + 1, MYTHIC_GUARANTEE - 1);
  }
  return {
    tier,
    pity: {
      gold: tier >= 4 ? 0 : Math.min(pity.gold + 1, HARD_PITY - 1),
      red: tier >= 3 ? 0 : Math.min(pity.red + 1, RED_PITY - 1),
      mythic,
    },
  };
}

/** MYTHIC_CHANCE, scaled like the tier rates by mythical versus gold tracks in the source. */
function mythicChance(scale?: RateScale): number {
  if (!scale) return MYTHIC_CHANCE;
  const ratio = (tier: 4 | 5) => scale.library[tier] ? scale.pool[tier] / scale.library[tier] : 0;
  const mythic = MYTHIC_CHANCE * ratio(5);
  const gold = (1 - MYTHIC_CHANCE) * ratio(4);
  return mythic + gold ? mythic / (mythic + gold) : MYTHIC_CHANCE;
}

/**
 * Draws the next track of a round: rolls a tier with pity, then a track of that tier. With
 * `noRepeats`, tracks already picked this round are skipped; null means the pool is used up.
 * With `library` (tracks per tier in the whole library), the rates follow the source's tiers (RateScale).
 */
export function drawTrack<T extends { id: string }>(
  pool: readonly T[], picked: ReadonlySet<string>, noRepeats: boolean, pity: Pity,
  tierOf: (track: T) => RarityTier, random: () => number = Math.random, library?: TierCounts,
): { track: T; tier: RarityTier; pity: Pity } | null {
  const byTier = new Map<RarityTier, T[]>();
  for (const track of noRepeats ? pool.filter((t) => !picked.has(t.id)) : pool) {
    const tier = tierOf(track);
    byTier.set(tier, [...(byTier.get(tier) ?? []), track]);
  }
  const scale = library && { pool: tierCounts([...byTier].flatMap(([tier, tracks]) => tracks.map(() => tier))), library };
  const roll = rollTier(pity, new Set(byTier.keys()), random, scale);
  if (!roll) return null;
  return { track: pickRandom(byTier.get(roll.tier)!, random)!, ...roll };
}
