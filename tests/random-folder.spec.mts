import { describe, expect, it, vi } from 'vitest';
import type { FolderNode } from '../src/app/core/models/folder.model';
import { REEL_LENGTH, REEL_MAX_OFFSET, HARD_PITY, MYTHIC_GUARANTEE, RED_PITY, buildReel, collectTrackIds, drawTrack, goldRate, rollTier, leadArtist, listFolders, pickRandom, popularityTiers, sourceTrackIds, tierCounts, trackRegions } from '../src/app/features/random-folder/random-folder.utils';

const file = (id: string, trackId?: string): FolderNode => ({ id, name: id, path: `/music/${id}`, isFolder: false, trackId });
const folder = (id: string, children?: FolderNode[]): FolderNode => ({ id, name: id, path: `/music/${id}`, isFolder: true, children });
const nested = folder('nested', [file('deep.flac', 'deep')]);
const child = folder('child', [file('child.flac', 'child-track'), nested]);
const root = folder('root', [file('root.flac', 'root-track'), child, file('unindexed.flac')]);

describe('random folder helpers', () => {
  it('lists roots and nested folders in tree order, excluding files', () => {
    const empty = folder('empty');
    expect(listFolders([root, file('ignored'), empty])).toEqual([root, child, nested, empty]);
    expect(listFolders([])).toEqual([]);
  });

  it('collects only direct indexed files when recursion is disabled', () => {
    expect(collectTrackIds(root, false)).toEqual(['root-track']);
    expect(collectTrackIds(child, false)).toEqual(['child-track']);
  });

  it('collects nested indexed files in tree order when recursion is enabled', () => {
    expect(collectTrackIds(root, true)).toEqual(['root-track', 'child-track', 'deep']);
  });

  it('handles empty folders and file nodes without collecting tracks', () => {
    expect(collectTrackIds(folder('empty'), true)).toEqual([]);
    expect(collectTrackIds(file('file.flac', 'file'), true)).toEqual([]);
  });

  it('keeps duplicate track ids from appearing more than once in a queue', () => {
    expect(collectTrackIds(folder('duplicates', [file('a', 'same'), folder('sub', [file('b', 'same')])]), true)).toEqual(['same']);
  });

  it('joins several ticked sources without repeating a track, even when one sits inside another', () => {
    expect(sourceTrackIds([child, nested, folder('other', [file('o', 'other-track')])], true)).toEqual(['child-track', 'deep', 'other-track']);
    expect(sourceTrackIds([child, nested], false)).toEqual(['child-track', 'deep']);
  });

  it('picks the first, middle and last items using an injected random source', () => {
    const items = [{ id: 'first' }, { id: 'middle' }, { id: 'last' }];
    expect(pickRandom(items, () => 0)).toBe(items[0]);
    expect(pickRandom(items, () => 0.5)).toBe(items[1]);
    expect(pickRandom(items, () => 0.999999)).toBe(items[2]);
    expect(items.map((item) => item.id)).toEqual(['first', 'middle', 'last']);
  });

  it('returns null for no candidates without consuming randomness', () => {
    const random = vi.fn(() => 0.5);
    expect(pickRandom([], random)).toBeNull();
    expect(random).not.toHaveBeenCalled();
    expect(pickRandom(['only'], () => 0.9)).toBe('only');
  });
});

describe('buildReel', () => {
  it('puts the pick at the winner slot and keeps the stop offset inside the cell', () => {
    const pool = ['a', 'b', 'c'];
    const low = buildReel(() => pool[0], 'pick', () => 0);
    expect(low.items).toHaveLength(REEL_LENGTH);
    expect(low.items[low.winnerIndex]).toBe('pick');
    expect(low.items.filter((item) => item === 'pick')).toHaveLength(1);
    expect(low.offset).toBeCloseTo(-REEL_MAX_OFFSET);
    expect(buildReel(() => pool[0], 'pick', () => 0.999999).offset).toBeLessThanOrEqual(REEL_MAX_OFFSET);
  });
});

describe('gacha rolls', () => {
  const all = new Set([1, 2, 3, 4] as const);
  const withMythic = new Set([1, 2, 3, 4, 5] as const);
  const pity = (gold: number, red: number, mythic = 0) => ({ gold, red, mythic });

  it('raises the gold rate from soft pity and guarantees gold at hard pity', () => {
    expect(goldRate(1)).toBeCloseTo(0.015);
    expect(goldRate(45)).toBeCloseTo(0.375);
    expect(rollTier(pity(HARD_PITY - 1, 0), all, () => 0)!.tier).toBe(4);
  });

  it('guarantees red or better within the red pity window', () => {
    expect(rollTier(pity(0, RED_PITY - 1), all, () => 0)!.tier).toBe(3);
  });

  it('resets the counters a hit satisfies', () => {
    expect(rollTier(pity(49, 5), all, () => 0)!.pity).toEqual(pity(0, 0, 1));
    expect(rollTier(pity(3, 9), all, () => 0)!.pity).toEqual(pity(4, 0));
    expect(rollTier(pity(3, 2), all, () => 0)!.pity).toEqual(pity(4, 3));
  });

  it('hands an empty tier its rate below and never lets a full counter flood the fallback', () => {
    const noGold = new Set([1, 2, 3] as const);
    expect(rollTier(pity(0, 0), new Set([1, 2] as const), () => 0.99)!.tier).toBe(2);
    expect(rollTier(pity(HARD_PITY - 1, 0), noGold, () => 0)!.tier).toBe(1);
    expect(rollTier(pity(HARD_PITY - 1, 0), noGold, () => 0)!.pity.gold).toBe(HARD_PITY - 1);
    expect(rollTier(pity(0, 0), new Set(), () => 0)).toBeNull();
  });

  it('upgrades a top roll to mythical on the coin flip or the guarantee', () => {
    const flips = (...values: number[]) => () => values.shift()!;
    // The top roll (0), then the mythic flip.
    expect(rollTier(pity(HARD_PITY - 1, 0), withMythic, flips(0, 0.1))!).toEqual({ tier: 5, pity: pity(0, 0, 0) });
    expect(rollTier(pity(HARD_PITY - 1, 0, 1), withMythic, flips(0, 0.9))!).toEqual({ tier: 4, pity: pity(0, 0, 2) });
    expect(rollTier(pity(HARD_PITY - 1, 0, MYTHIC_GUARANTEE - 1), withMythic, flips(0, 0.9))!.tier).toBe(5);
  });

  it('keeps the mythic counter one short without mythical tracks, and gives mythical when gold is missing', () => {
    expect(rollTier(pity(HARD_PITY - 1, 0, MYTHIC_GUARANTEE - 1), all, () => 0)!.pity.mythic).toBe(MYTHIC_GUARANTEE - 1);
    expect(rollTier(pity(HARD_PITY - 1, 0), new Set([1, 5] as const), () => 0.9)!.tier).toBe(5);
  });

  it('scales the rates by the source tiers against the library', () => {
    const library = { 1: 400, 2: 300, 3: 200, 4: 80, 5: 20 };
    const flips = (...values: number[]) => () => values.shift()!;
    // A folder of hits (1 base, 1 gold, 6 mythical): the lone base track no longer takes 65%.
    const hits = { pool: { 1: 1, 2: 0, 3: 0, 4: 1, 5: 6 }, library };
    const folder = new Set([1, 4, 5] as const);
    expect(rollTier(pity(0, 0), folder, flips(0.7))!.tier).toBe(1);
    expect(rollTier(pity(0, 0), folder, flips(0.7, 0.5), hits)!.tier).toBe(5);
    // A source shaped like the library rolls at the listed rates.
    for (const point of [0.1, 0.8, 0.95, 0.99]) {
      expect(rollTier(pity(0, 0), all, () => point, { pool: library, library })!.tier).toBe(rollTier(pity(0, 0), all, () => point)!.tier);
    }
    // Stale library counts fall back to the listed rates.
    expect(rollTier(pity(0, 0), folder, flips(0.7), { pool: hits.pool, library: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } })!.tier).toBe(1);
  });

  it('counts tracks per tier', () => {
    expect(tierCounts([1, 1, 4, 5, 5, 5])).toEqual({ 1: 2, 2: 0, 3: 0, 4: 1, 5: 3 });
  });

  it('draws a track of the rolled tier and skips picked tracks without repeats', () => {
    const pool = [{ id: 'g', t: 1 }, { id: 'a', t: 4 }] as const;
    const tierOf = (track: { t: number }) => track.t as 1 | 4;
    expect(drawTrack(pool, new Set(), false, pity(49, 0), tierOf, () => 0)!.track.id).toBe('a');
    expect(drawTrack(pool, new Set(['a']), true, pity(49, 0), tierOf, () => 0)!.track.id).toBe('g');
    expect(drawTrack(pool, new Set(['a', 'g']), true, pity(0, 0), tierOf)).toBeNull();
  });
});

describe('popularityTiers', () => {
  // Ten tracks per region, views 1..10 (VN) and 100..1000 (KOR): 1 gold, 2 red, 3 blue, 4 base each.
  const region = (name: string, scale: number) => Array.from({ length: 10 }, (_, i) => ({ id: `${name}${i + 1}`, region: name, artist: `${name}${i + 1}`, views: (i + 1) * scale }));
  const tracks = [...region('VN', 1), ...region('KOR', 100)];

  it('makes the top 2% mythical and keeps gold to two tracks per artist', () => {
    // 50 tracks: 1 mythical (50), gold down to 46, red down to 36. One artist has 49, 48 and 47.
    const big = Array.from({ length: 50 }, (_, i) => ({ id: `t${i + 1}`, region: 'US', artist: i + 1 >= 47 && i + 1 <= 49 ? 'X' : `a${i + 1}`, views: i + 1 }));
    const tiers = popularityTiers(big);
    expect(['t50', 't49', 't48', 't47', 't46', 't45'].map((id) => tiers.get(id))).toEqual([5, 4, 4, 3, 4, 3]);
  });

  it('takes the lead artist from a credit list', () => {
    expect(leadArtist('Machiot, Tlinh, Trung Trần')).toBe('Machiot');
    expect(leadArtist('Jung Kook feat. Latto')).toBe('Jung Kook');
    expect(leadArtist(null)).toBe('');
  });

  it('ranks views within each region, gold being the most viewed', () => {
    const tiers = popularityTiers(tracks);
    expect(['VN10', 'VN9', 'VN8', 'VN7', 'VN5', 'VN4'].map((id) => tiers.get(id))).toEqual([4, 3, 3, 2, 2, 1]);
    expect(tiers.get('KOR10')).toBe(4);
    expect(tiers.get('KOR1')).toBe(1);
  });

  it('ranks folders kept off their own scale against the whole library', () => {
    const odd = (views: number) => ({ id: 'odd', region: 'Random ass', artist: 'odd', views });
    const tiers = popularityTiers([...tracks, odd(1)]);
    expect(tiers.get('odd')).toBe(1);
    expect(popularityTiers([...tracks, odd(1000)]).get('odd')).toBe(4);
  });

  it('leaves tracks without views out, and rounds an empty gold tier to none', () => {
    const tiers = popularityTiers([
      { id: 'none', region: 'VN', artist: 'n', views: null }, { id: 'a', region: 'JP', artist: 'a', views: 5 }, { id: 'b', region: 'JP', artist: 'b', views: 9 },
    ]);
    expect(tiers.has('none')).toBe(false);
    expect([tiers.get('b'), tiers.get('a')]).toEqual([3, 1]);
  });
});

describe('trackRegions', () => {
  it('maps tracks to the top-level folder under their root, or the root for files directly in it', () => {
    expect([...trackRegions([root])]).toEqual([['root-track', 'root'], ['child-track', 'child'], ['deep', 'child']]);
  });
});
