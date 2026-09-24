// A report is read from the saved snapshot (server reports/gather.ts), and
// the room saves a sheet 1.5 s after it goes quiet. So a report asked for
// right after an edit would leave the edit out. This waits until the saved
// scene holds every element at least at the version this tab shows, and
// says so when it gives up rather than handing over a stale report.

type Versioned = { id: string; version: number; isDeleted?: boolean };

/** True when `saved` holds an element older than `local` does, or lacks
 * one `local` shows. The saved scene a report carries holds live elements
 * only, so a local delete counts as saved once the element is gone. */
export function isBehind(
  local: readonly Versioned[],
  saved: readonly unknown[],
): boolean {
  const savedVersion = new Map<string, number>();
  for (const el of saved as Partial<Versioned>[])
    if (typeof el?.id === 'string' && typeof el.version === 'number')
      savedVersion.set(el.id, el.version);
  return local.some((el) => {
    const at = savedVersion.get(el.id);
    if (el.isDeleted) return at !== undefined;
    return (at ?? -1) < el.version;
  });
}

export type SavedResult<T> = { report: T; complete: boolean };

/** Asks `fetch` until the report's scene has caught up with `local`, up to
 * `tries` times. `complete` is false when it never did. */
export async function whenSaved<
  T extends { scene: { elements: unknown[] } | null },
>(
  fetch: () => Promise<T>,
  local: readonly Versioned[],
  wait: (ms: number) => Promise<void>,
  tries = 12,
  ms = 500,
): Promise<SavedResult<T>> {
  let report = await fetch();
  for (let i = 1; i < tries; i++) {
    if (!isBehind(local, report.scene?.elements ?? [])) break;
    await wait(ms);
    report = await fetch();
  }
  return {
    report,
    complete: !isBehind(local, report.scene?.elements ?? []),
  };
}
