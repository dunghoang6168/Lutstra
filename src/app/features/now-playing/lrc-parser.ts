import { LyricLine } from '../../core/models';

const TIMESTAMP = /\[(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\]/g;

export function parseLrc(contents: string): LyricLine[] {
  const offsetTag = contents.match(/\[offset:([+-]?\d+)\]/i);
  const offsetSeconds = offsetTag ? Number(offsetTag[1]) / 1000 : 0;
  const lines: LyricLine[] = [];
  for (const row of contents.split(/\r\n|\n|\r/)) {
    const matches = [...row.matchAll(TIMESTAMP)];
    if (matches.length === 0) continue;
    const text = row.replace(TIMESTAMP, '').trim();
    if (!text) continue;
    for (const match of matches) {
      const seconds = Number(match[1]) * 60 + Number(match[2]) + Number(`0.${(match[3] ?? '').padEnd(3, '0')}`);
      if (Number(match[2]) >= 60) continue;
      lines.push({ time: Math.max(0, seconds + offsetSeconds), text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** The words alone, one entry per line: timestamps and tag rows ("[ar:…]") dropped, as the phone's Plain view shows them. */
export function plainLyrics(contents: string): string[] {
  return contents.split(/\r\n|\n|\r/)
    .filter((row) => !/^\s*\[[a-z]+:[^\]]*\]\s*$/i.test(row))
    .map((row) => row.replace(TIMESTAMP, '').trim())
    .filter((row) => row.length > 0);
}

export function activeLyricIndex(lines: LyricLine[], currentTime: number): number {
  if (!Number.isFinite(currentTime)) return -1;
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lines[mid].time <= currentTime) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}
