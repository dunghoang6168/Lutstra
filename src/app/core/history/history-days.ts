import { HistoryEntry, Track } from '../models';

export interface HistoryRow {
  id: string;
  track: Track;
  startedAt: number;
}

export interface HistoryDay {
  key: string;
  label: string;
  rows: HistoryRow[];
}

const dayKey = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
};

/** Groups rows (newest first) by local day: Today, Yesterday, then the date. */
export function historyDays(rows: readonly HistoryRow[], now: number): HistoryDay[] {
  const today = dayKey(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate.getTime());
  const thisYear = new Date(now).getFullYear();
  const days: HistoryDay[] = [];
  for (const row of rows) {
    const key = dayKey(row.startedAt);
    let day = days.at(-1);
    if (day?.key !== key) {
      const date = new Date(row.startedAt);
      const label = key === today ? 'Today' : key === yesterday ? 'Yesterday'
        : date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: date.getFullYear() === thisYear ? undefined : 'numeric' });
      day = { key, label, rows: [] };
      days.push(day);
    }
    day.rows.push(row);
  }
  return days;
}

/** Adds a newly fetched page to the loaded entries: no duplicates, newest first. */
export function mergeHistory(current: readonly HistoryEntry[], page: readonly HistoryEntry[]): HistoryEntry[] {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of page) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => b.startedAt - a.startedAt || b.id - a.id);
}

export type HistoryRange = 'today' | 'week' | 'month' | 'all';

/** Where a range starts, in local time: midnight today, Monday of this week, the 1st of this month, or the beginning. */
export function historyRangeStart(range: HistoryRange, now: number): number {
  if (range === 'all') return 0;
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (range === 'week') date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  if (range === 'month') date.setDate(1);
  return date.getTime();
}
