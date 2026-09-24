import type { FindFilterClause, FindFilterOp } from '@digsite/shared/api';
// The find/filter grammar (docs/phases/6-product.md "Find and filter"):
// `[{key, op, value}]` over typed properties, validated strictly — no SQL
// from the client, ever. A property's TYPE is inferred from the board's own
// data (same discipline as boards/routes.ts#sortableKeysFor), not declared
// by the client, so a clause can never claim a property is a type it isn't.
//
// Independent of @digsite/shared/board/sort.ts's `PropertyType` (which this
// task's scope does not touch — see this task's report): 'date' needs no
// separate SQL type at all, since an ISO `YYYY-MM-DD` string compares
// correctly under plain text lt/lte/gt/gte/between (lexicographic order on
// a fixed-width ISO date IS calendar order) — it rides the 'text' path
// below. 'list' (a jsonb array) gets its own `has` op.
import { pool } from '../db/pool.ts';
import { ensurePropertyIndex, isValidPropertyKey } from './property-index.ts';

export type FilterOp = FindFilterOp;
const FILTER_OPS: ReadonlySet<string> = new Set([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'in',
  'has',
]);

export type FilterClause = FindFilterClause;

type PropType = 'text' | 'number' | 'boolean' | 'date' | 'list' | 'unknown';

async function propertyTypeOf(boardId: string, key: string): Promise<PropType> {
  const { rows } = await pool.query(
    `SELECT jsonb_typeof(properties -> $2) AS t,
       bool_and(properties->>$2 ~ '^\\d{4}-\\d{2}-\\d{2}$') AS all_dates
     FROM images WHERE board_id = $1 AND properties ? $2
     GROUP BY jsonb_typeof(properties -> $2)`,
    [boardId, key],
  );
  const types = rows.filter((r) => r.t).map((r) => r.t);
  if (types.length !== 1) return 'unknown'; // absent, or mixed types on this board
  const t = types[0];
  if (t === 'string') return rows[0]?.all_dates ? 'date' : 'text';
  if (t === 'number') return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'array') return 'list';
  return 'unknown';
}

function isScalar(v: unknown): v is string | number | boolean {
  return (
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
  );
}

function matchesType(v: unknown, type: PropType): boolean {
  if (type === 'text') return typeof v === 'string';
  if (type === 'date')
    return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (type === 'boolean') return typeof v === 'boolean';
  return false;
}

const OPS_BY_TYPE: Record<PropType, ReadonlySet<FilterOp>> = {
  text: new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in']),
  date: new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in']),
  number: new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in']),
  boolean: new Set(['eq', 'neq']),
  list: new Set(['has']),
  unknown: new Set(),
};

export type BuiltFilter = { sql: string; params: unknown[] };

/** Validates and compiles one board's worth of filter clauses into a single
 * SQL boolean expression plus its parameters, starting at `$(paramOffset)`.
 * Throws FilterRefused (the route turns it into 400) on anything
 * strict — an unknown key's type, a bad op for that type, or a
 * value shape that doesn't match. Every VALUE is a bind parameter; the only
 * things ever interpolated are the property key (regex-checked first, same
 * as ranks.ts#orderExpr) and the fixed op-to-SQL-operator mapping below. */
/** A filter the grammar refuses: the asker's fault, and a 400. Anything
 * else thrown while finding (the database) is the server's. */
export class FilterRefused extends Error {}

export async function buildFilterSql(
  boardId: string,
  clauses: FilterClause[],
  paramOffset: number,
): Promise<BuiltFilter> {
  const parts: string[] = [];
  const params: unknown[] = [];
  let n = paramOffset;

  for (const clause of clauses) {
    if (!clause || typeof clause.key !== 'string') {
      throw new FilterRefused('filter clause needs a key');
    }
    if (!isValidPropertyKey(clause.key)) {
      throw new FilterRefused(`bad filter key: ${clause.key}`);
    }
    if (!FILTER_OPS.has(clause.op)) {
      throw new FilterRefused(`bad filter op: ${clause.op}`);
    }
    const type = await propertyTypeOf(boardId, clause.key);
    if (type === 'unknown') {
      // Not an error (a client may filter on a property that doesn't
      // (yet) exist on this board, or one with mixed types) — a clause
      // that can never match narrows the whole query to nothing, honestly.
      parts.push('false');
      continue;
    }
    if (!OPS_BY_TYPE[type].has(clause.op)) {
      throw new FilterRefused(
        `op ${clause.op} does not apply to a ${type} property`,
      );
    }

    try {
      await ensurePropertyIndex(boardId, clause.key, type);
    } catch {
      // best-effort, see property-index.ts's own comment.
    }

    const col =
      type === 'number'
        ? `CASE WHEN jsonb_typeof(properties->'${clause.key}') = 'number' THEN (properties->>'${clause.key}')::numeric END`
        : type === 'boolean'
          ? `CASE WHEN jsonb_typeof(properties->'${clause.key}') = 'boolean' THEN (properties->>'${clause.key}')::boolean END`
          : `CASE WHEN jsonb_typeof(properties->'${clause.key}') = '${type === 'list' ? 'array' : 'string'}' THEN properties->>'${clause.key}' END`;

    if (clause.op === 'has') {
      if (!isScalar(clause.value))
        throw new FilterRefused('has needs a scalar value');
      parts.push(`properties->'${clause.key}' @> $${n}::jsonb`);
      params.push(JSON.stringify([clause.value]));
      n++;
      continue;
    }

    if (clause.op === 'in') {
      if (!Array.isArray(clause.value) || clause.value.length === 0) {
        throw new FilterRefused('in needs a non-empty array of values');
      }
      if (!clause.value.every((v) => matchesType(v, type))) {
        throw new FilterRefused(`in values must all be ${type}`);
      }
      parts.push(`${col} = ANY($${n})`);
      params.push(clause.value);
      n++;
      continue;
    }

    if (clause.op === 'between') {
      if (!Array.isArray(clause.value) || clause.value.length !== 2) {
        throw new FilterRefused('between needs a [lo, hi] array');
      }
      const [lo, hi] = clause.value;
      if (!matchesType(lo, type) || !matchesType(hi, type)) {
        throw new FilterRefused(`between values must be ${type}`);
      }
      parts.push(`${col} BETWEEN $${n} AND $${n + 1}`);
      params.push(lo, hi);
      n += 2;
      continue;
    }

    // eq/neq/lt/lte/gt/gte: one scalar value of the property's own type.
    if (!matchesType(clause.value, type)) {
      throw new FilterRefused(`value must be ${type}`);
    }
    const opSql: Record<string, string> = {
      eq: '=',
      neq: '!=',
      lt: '<',
      lte: '<=',
      gt: '>',
      gte: '>=',
    };
    parts.push(`${col} ${opSql[clause.op]} $${n}`);
    params.push(clause.value);
    n++;
  }

  return { sql: parts.length ? parts.join(' AND ') : 'true', params };
}
