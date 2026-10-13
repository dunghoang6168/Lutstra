/** One entry of `yt-dlp ytsearchN:<query> --flat-playlist -J`. */
export interface YoutubeEntry {
  id?: string;
  title?: string;
  channel?: string | null;
  uploader?: string | null;
  url?: string;
  view_count?: number | null;
  duration?: number | null;
}

// Bracketed version notes that the plain upload of a track does not carry.
const VERSION_NOTE = /\s*[([][^)\]]*\b(?:remaster(?:ed)?|live|ver\.?|version|mono|stereo|edit|explicit|feat\.?|ft\.?)(?![\p{L}\p{N}])[^)\]]*[)\]]/giu;
const DASH_NOTE = /\s+-\s+[^-]*\b(?:remaster(?:ed)?|live|version|edit)\b.*$/iu;
const BARE_FEAT = /\s+(?:feat\.?|ft\.?)\s.*$/iu;
// Uploads that are not the track itself, unless the track title says so.
const OTHER_UPLOAD = /\b(?:cover|karaoke|reaction|sped up|slowed|nightcore|8d|instrumental|remix|tutorial|piano|live|extended|practice|fancam|choreography)\b/g;
// Track variants whose upload must say so too: a remix or instrumental never takes the original video's views.
const VARIANTS = [/mix\b/, /\b(?:instrumental|inst)\b/];
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Music videos often add an intro or outro (+100–150 s seen), so a longer upload gets more room than a
// shorter one. Intros and interludes rarely get a video, so short tracks stay strict and do not match medleys.
// ponytail: fixed bounds; a music video with more than 3 min of extras falls out and the audio upload wins.
const MAX_SHORTER_S = 30;
const MAX_LONGER_S = 180;
const SHORT_TRACK_S = 90;
const ARTIST_SPLIT = /\s*(?:,|&|\/|;|\bfeat\.?|\bft\.?|\bx\b)\s*/i;
// A bracketed group that stands apart, not one inside a word ("Go(o)d").
const BRACKET_GROUP = /(^|\s)[([][^)\]]*[)\]]/g;

const firstArtist = (artist: string | null) => artist?.split(ARTIST_SPLIT)[0]?.trim() ?? '';
const withoutBrackets = (title: string) => title.replace(BRACKET_GROUP, '$1').replace(/\s+/g, ' ').trim() || title.trim();

/** Strips version notes and featured artists so the search finds the main upload. */
export function cleanTitle(title: string): string {
  const cleaned = title.replace(VERSION_NOTE, '').replace(DASH_NOTE, '').replace(BARE_FEAT, '').trim();
  return cleaned || title.trim();
}

/** Lower case, no diacritics (đ included), punctuation folded to single spaces. */
export function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** First credited artist and the clean title, on one line; long credit lists bury the track in results. */
export function searchQuery(artist: string | null, title: string): string {
  return `${firstArtist(artist)} ${cleanTitle(title)}`.replace(/\s+/g, ' ').trim();
}

/**
 * A second query for a track the first search missed: the title without its last word. YouTube search
 * returns nothing for some words ("Drake Janice STFU") while "Drake Janice" finds the track. Null for
 * one-word titles.
 */
export function fallbackQuery(artist: string | null, title: string): string | null {
  const words = withoutBrackets(cleanTitle(title)).split(' ');
  return words.length > 1 ? `${firstArtist(artist)} ${words.slice(0, -1).join(' ')}`.trim() : null;
}

/** Splits items into runs whose total length stays under `maxChars` (one item may exceed it alone). */
export function chunkByLength(items: readonly string[], maxChars: number): string[][] {
  const chunks: string[][] = [];
  let length = Infinity;
  for (const item of items) {
    if (length + item.length + 1 > maxChars) {
      chunks.push([]);
      length = 0;
    }
    chunks.at(-1)!.push(item);
    length += item.length + 1;
  }
  return chunks;
}

/** Groups tracks by search query, so tracks that search the same text share one search. */
export function groupByQuery<T extends { id: string; artist: string | null; title: string }>(
  tracks: readonly T[], queryOf: (artist: string | null, title: string) => string = searchQuery,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const track of tracks) {
    const query = queryOf(track.artist, track.title);
    groups.set(query, [...(groups.get(query) ?? []), track]);
  }
  return groups;
}

/** Every word, as often as it is wanted, in any order; unspaced CJK runs may sit inside longer runs. */
function hasWords(text: string, words: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const word of text.split(' ')) counts.set(word, (counts.get(word) ?? 0) + 1);
  return words.every((word) => {
    if (CJK.test(word)) return text.includes(word);
    const left = counts.get(word) ?? 0;
    counts.set(word, left - 1);
    return left > 0;
  });
}

/**
 * Picks the most viewed result that names the track, runs about as long, and is not a cover, remix,
 * live take or similar (unless the track title or artist says so). Results that also name the artist in the
 * title or channel win over the rest, so a cover album does not match the original. Null when nothing qualifies.
 */
export function pickVideo(entries: readonly YoutubeEntry[], title: string, durationS: number, artist: string | null = null): YoutubeEntry | null {
  // Every word of the title outside brackets, in any order: uploads drop or move bracketed aliases
  // ("眩いばかり (Dazzling)", "mosi mosi? LEESOL (KiiiKiii) Remix") and reorder notes ("Nước Mắt Cá Sấu Interlude").
  // Counting repeats keeps "Eh, Eh" off "Mo-Eh-Wa".
  const wanted = normalize(withoutBrackets(cleanTitle(title))).split(' ');
  // The artist counts too ("DPR LIVE" is not a live take), and a "…mix" title ("Machimix") allows a remix.
  const own = normalize(`${title} ${artist ?? ''}`);
  const allowed = (word: string) => own.includes(word) || (word === 'remix' && /mix\b/.test(own));
  // Bracketed notes are dropped from `wanted`, so "Chạy Ngay Đi (Onionn Remix)" would match the original.
  const variants = VARIANTS.filter((variant) => variant.test(normalize(title)));
  // Words of the first credited artist; "the" and one-letter words are often dropped ("Jackson 5 - …").
  const artistWords = normalize(firstArtist(artist)).split(' ').filter((word) => word.length > 1 && word !== 'the');
  const hasWord = (text: string, word: string) => CJK.test(word) ? text.includes(word) : ` ${text} `.includes(` ${word} `);
  let best: YoutubeEntry | null = null;
  let bestNamesArtist = false;
  for (const entry of entries) {
    if (typeof entry.view_count !== 'number' || !entry.title) continue;
    const name = normalize(entry.title);
    if (!hasWords(name, wanted)) continue;
    if ((name.match(OTHER_UPLOAD) ?? []).some((word) => !allowed(word))) continue;
    if (variants.some((variant) => !variant.test(name))) continue;
    const extra = entry.duration && durationS > 0 ? entry.duration - durationS : 0;
    if (extra < -MAX_SHORTER_S || extra > (durationS < SHORT_TRACK_S ? MAX_SHORTER_S : MAX_LONGER_S)) continue;
    const credit = `${name} ${normalize(entry.channel ?? entry.uploader ?? '')}`;
    // Any one word is enough: channels often drop part of the name ("RPT MCK" posts as "MCK // Nger").
    const namesArtist = artistWords.some((word) => hasWord(credit, word));
    if (!best || (namesArtist && !bestNamesArtist) || (namesArtist === bestNamesArtist && entry.view_count > best.view_count!)) {
      best = entry;
      bestNamesArtist = namesArtist;
    }
  }
  return best;
}
