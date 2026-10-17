/** Where a dragged row lands: before the first other row whose middle is below the finger; past them all, after the last. */
export function dropSlot(rows: { id: string; middle: number }[], y: number): { targetId: string | null; placement: 'before' | 'after' } {
  const below = rows.find((row) => y < row.middle);
  return below ? { targetId: below.id, placement: 'before' } : { targetId: rows.at(-1)?.id ?? null, placement: 'after' };
}
