// What a web asks (CONTEXT.md "Web"): which pictures it starts from, how
// many steps out, and which relation, if only one. No start pictures is the
// board's whole web. The question lives in the board's URL (`?view=web&…`),
// so a web can be linked, reloaded and gone back to, and every way into
// the web (a selection, a Find, a sheet, a relation, a connection) is one
// question handed to one page. Pure.

export type Hops = 1 | 2 | 3;

export type WebQuestion = {
  roots: string[];
  hops: Hops;
  relation: string | null;
};

/** More start pictures than this is a question nobody can read an answer
 * to; the page says it kept the first ones. */
export const MAX_ROOTS = 40;

const isHops = (n: number): n is Hops => n === 1 || n === 2 || n === 3;

/** Many start pictures reach far in two steps; one step keeps a web of a
 * selection readable. */
export function defaultHops(roots: readonly string[]): Hops {
  return roots.length > 3 ? 1 : 2;
}

export function webQuestion(
  roots: readonly string[],
  opts: { hops?: Hops; relation?: string | null } = {},
): WebQuestion {
  const unique = [...new Set(roots)].slice(0, MAX_ROOTS);
  return {
    roots: unique,
    hops: opts.hops ?? defaultHops(unique),
    relation: opts.relation?.trim() || null,
  };
}

/** The question as the board URL's search, `view=web` first. */
export function webSearch(q: WebQuestion): string {
  const p = new URLSearchParams({ view: 'web' });
  if (q.roots.length) p.set('roots', q.roots.join(','));
  p.set('hops', String(q.hops));
  if (q.relation) p.set('relation', q.relation);
  return `?${p}`;
}

/** The question in the board's URL, or null when the board shows its map. */
export function readWebQuestion(params: URLSearchParams): WebQuestion | null {
  if (params.get('view') !== 'web') return null;
  const roots = (params.get('roots') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hops = Number(params.get('hops'));
  return webQuestion(roots, {
    hops: isHops(hops) ? hops : undefined,
    relation: params.get('relation'),
  });
}

/** How the page names the question. */
export function webTitle(
  q: WebQuestion,
  nameOf: (id: string) => string | undefined,
): string {
  const of = q.relation ? `“${q.relation}”` : '';
  if (!q.roots.length)
    return q.relation
      ? `Every picture ${of} joins`
      : 'The whole web of this board';
  const names = q.roots.slice(0, 2).map((id) => nameOf(id) ?? 'a picture');
  const rest = q.roots.length - names.length;
  const start =
    rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(' and ');
  return q.relation ? `${of} around ${start}` : `The web around ${start}`;
}
