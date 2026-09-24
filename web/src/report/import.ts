// A report brought back in (CONTEXT.md "Report import"; docs/roadmap.md
// "Report export", R7): its claims become a new sheet's own, on the
// pictures this board holds with the same bytes. A report names every
// picture by its original's SHA-256, so it can come from another board or
// another digsite and still land on the right pictures.
//
// Like a copy of another sheet's claim, an imported claim is an ordinary
// own claim from the moment it exists: the importer's stamp, nothing about
// where it came from. What cannot land is said, never silently dropped.
//
// Pure: a report and what the board holds in, a plan out.
import {
  type Confidence,
  type Direction,
  type Fraction,
  type Properties,
  type ReportData,
  SHEET_LIMIT,
  dataOf,
  isReportData,
} from '@digsite/shared';

export type ImportEnd = {
  imageId: string;
  fraction: Fraction | null;
  /** The region's label, when the end is a region. */
  label: string | null;
  /** Ends naming the same key are one region on the new sheet. */
  regionKey: string | null;
};

export type ImportClaim = {
  kind: 'connection' | 'region';
  /** As its author wrote it: the new board's aliases decide what it means. */
  term: string;
  direction: Direction;
  confidence: Confidence | null;
  note: string;
  properties: Properties;
  ends: ImportEnd[];
};

export type ImportPlan = {
  title: string;
  /** This board's pictures, at most SHEET_LIMIT. */
  imageIds: string[];
  /** Each picture's centre on the report's sheet, when it had one: the new
   * sheet is made with them (CreateSheetRequest.positions). */
  positions: Record<string, { x: number; y: number }>;
  claims: ImportClaim[];
  /** What did not land, and why, one line each. */
  skipped: string[];
};

/** The report in a file: its JSON, or a report .html with its data block. */
export function readReportFile(text: string): ReportData | null {
  const block = text.match(
    /<script type="application\/json" id="digsite-report">(.*?)<\/script>/s,
  )?.[1];
  try {
    const data = JSON.parse(block ?? text);
    return isReportData(data) ? data : null;
  } catch {
    return null;
  }
}

export function importPlan(
  data: ReportData,
  held: readonly { id: string; sha256: string }[],
): ImportPlan {
  const bySha = new Map(held.map((h) => [h.sha256, h.id]));
  const here = new Map<string, string>();
  const names = new Map<string, string>();
  for (const img of data.images) {
    names.set(img.id, img.name);
    const id = bySha.get(img.sha256);
    if (id) here.set(img.id, id);
  }
  const skipped: string[] = [];
  const claims: ImportClaim[] = [];
  const pictures: string[] = [];
  /** Takes a claim's pictures only if all of them fit: a claim that
   * cannot land must not use up a place another could have. */
  const fit = (ids: string[]) => {
    const fresh = new Set(ids.filter((id) => !pictures.includes(id)));
    if (pictures.length + fresh.size > SHEET_LIMIT) return false;
    pictures.push(...fresh);
    return true;
  };
  const describe = (c: ReportData['claims'][number]) =>
    `${c.kind === 'connection' ? 'Connection' : 'Region'} “${c.typed || 'unnamed'}”`;

  // Regions first: an edge that rests on a region then finds it made.
  const ordered = [...data.claims].sort(
    (a, b) => Number(a.kind === 'connection') - Number(b.kind === 'connection'),
  );
  for (const c of ordered) {
    const missing = c.ends.find((e) => !here.has(e.imageId));
    if (missing) {
      skipped.push(
        `${describe(c)}: ${names.get(missing.imageId) ?? 'a picture'} is not on this board`,
      );
      continue;
    }
    const ends = c.ends.map((e) => here.get(e.imageId) as string);
    if (!fit(ends)) {
      skipped.push(
        `${describe(c)}: a sheet holds at most ${SHEET_LIMIT} pictures`,
      );
      continue;
    }
    claims.push({
      kind: c.kind,
      term: c.typed,
      direction: c.direction ?? 'none',
      confidence: c.confidence,
      note: c.note,
      properties: c.properties,
      ends: c.ends.map((e, i) => ({
        imageId: ends[i] as string,
        fraction: e.fraction,
        label: e.label,
        regionKey: e.regionKey,
      })),
    });
  }
  // A sheet report's own pictures come too, claimed or not: they are part
  // of what the sheet showed.
  for (const img of data.images) {
    const id = here.get(img.id);
    if (id) fit([id]);
  }

  const positions: ImportPlan['positions'] = {};
  for (const el of (data.scene?.elements ?? []) as {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    isDeleted?: boolean;
    customData?: unknown;
  }[]) {
    const d = dataOf(el);
    if (el.isDeleted || d?.kind !== 'image') continue;
    const id = here.get(d.imageId);
    const [x, y, w, h] = [el.x, el.y, el.width, el.height];
    if (
      id &&
      pictures.includes(id) &&
      [x, y, w, h].every((n) => typeof n === 'number' && Number.isFinite(n))
    )
      positions[id] = {
        x: (x as number) + (w as number) / 2,
        y: (y as number) + (h as number) / 2,
      };
  }

  return {
    title: data.title,
    imageIds: pictures,
    positions,
    claims,
    skipped,
  };
}
