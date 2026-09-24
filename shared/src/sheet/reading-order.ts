// Reading order on a sheet: rows top to bottom, then left to right, with
// pictures whose tops are within half a height of each other counted as one
// row. One definition for the keyboard walk (web sheet/reading-order.ts)
// and a report's order of claims (report/order.ts), so a report reads the
// sheet the way Tab walks it.

export type Placed = { x: number; y: number; width: number; height: number };

export function inReadingOrder<T extends Placed>(items: readonly T[]): T[] {
  const byTop = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: T[][] = [];
  for (const item of byTop) {
    const row = rows.at(-1);
    const first = row?.[0];
    if (row && first && item.y - first.y < first.height / 2) row.push(item);
    else rows.push([item]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}
