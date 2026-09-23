// A Sort's id is the only spelling that reaches a URL or board_ranks.sort_id.
// parseSortId refuses anything it would not itself have produced, so a
// property name can never smuggle SQL into an ORDER BY — see
// ../../.claude/rules/ladder-slot-vs-rank.md.

export type PropertyScalar = string | number | boolean;
export type PropertyValue = PropertyScalar | PropertyScalar[];
export type PropertyType = 'text' | 'number' | 'boolean' | 'date' | 'list';
export type SortKey =
  | 'name'
  | 'uploaded_at'
  // One arrangement of the whole board by what the pictures show; images
  // without an embedding come last (docs/roadmap.md item 6).
  | 'meaning'
  | { property: string; type: PropertyType };
export type Sort = { key: SortKey; dir: 'asc' | 'desc' };

const DIR_RE = /^(asc|desc)$/;
const PROPERTY_RE = /^[A-Za-z0-9_-]+$/;

export function sortId(s: Sort): string {
  if (typeof s.key === 'string') return `${s.key}.${s.dir}`;
  return `p.${s.key.type}.${s.key.property}.${s.dir}`;
}

function isDir(v: string | undefined): v is 'asc' | 'desc' {
  return v !== undefined && DIR_RE.test(v);
}

function isColumnKey(
  v: string | undefined,
): v is 'name' | 'uploaded_at' | 'meaning' {
  return v === 'name' || v === 'uploaded_at' || v === 'meaning';
}

function isPropertyType(v: string | undefined): v is PropertyType {
  return (
    v === 'text' ||
    v === 'number' ||
    v === 'boolean' ||
    v === 'date' ||
    v === 'list'
  );
}

export function parseSortId(id: string): Sort | null {
  const parts = id.split('.');

  if (parts.length === 2) {
    const [key, dir] = parts;
    if (!isColumnKey(key) || !isDir(dir)) return null;
    return { key, dir };
  }

  if (parts.length === 4) {
    const [tag, type, property, dir] = parts;
    if (tag !== 'p') return null;
    if (!isPropertyType(type)) return null;
    if (!property || !PROPERTY_RE.test(property)) return null;
    if (!isDir(dir)) return null;
    return { key: { property, type }, dir };
  }

  return null;
}

export const DEFAULT_SORT: Sort = { key: 'uploaded_at', dir: 'desc' };
