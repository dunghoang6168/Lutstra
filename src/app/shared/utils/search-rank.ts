/** Search ranking shared by the desktop global search and the phone Search page. */

/** `query` is already normalized. Title starts with the query, then contains it; then a secondary field starts with it, then contains it. Ties keep input order. */
export function rankMatches<T>(items: T[], query: string, primary: (item: T) => string, secondary: (item: T) => Array<string | null>): T[] {
  return items
    .map((item, index) => ({ item, index, score: matchScore(primary(item), secondary(item), query) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.item);
}

function matchScore(primary: string, secondary: Array<string | null>, query: string): number {
  const normalizedPrimary = normalizeSearch(primary);
  if (normalizedPrimary.startsWith(query)) return 0;
  if (normalizedPrimary.includes(query)) return 1;
  const normalizedSecondary = secondary.filter((value): value is string => Boolean(value)).map(normalizeSearch);
  if (normalizedSecondary.some((value) => value.startsWith(query))) return 2;
  if (normalizedSecondary.some((value) => value.includes(query))) return 3;
  return Number.POSITIVE_INFINITY;
}

/** Case and Vietnamese diacritics (including đ) do not matter. */
export function normalizeSearch(value: string): string {
  return value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replaceAll('đ', 'd');
}
