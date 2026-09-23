import { createHash } from 'node:crypto';
import type { PropertyType } from '@digsite/shared/board/sort';
import { pool } from '../db/pool.ts';

const PROPERTY_RE = /^[A-Za-z0-9_-]+$/;

export function isValidPropertyKey(key: string): boolean {
  return key.length <= 100 && PROPERTY_RE.test(key);
}

const inFlight = new Map<string, Promise<void>>();

/** Builds the index shape used by this typed key and records it per board. */
export async function ensurePropertyIndex(
  boardId: string,
  key: string,
  type: PropertyType,
): Promise<void> {
  if (!isValidPropertyKey(key)) return;
  const dedupeKey = `${boardId}:${type}:${key}`;
  const existingWork = inFlight.get(dedupeKey);
  if (existingWork) return existingWork;

  const work = (async () => {
    const { rows } = await pool.query(
      `SELECT 1 FROM board_property_indexes
       WHERE board_id = $1 AND property_key = $2 AND property_type = $3`,
      [boardId, key, type],
    );
    if (rows.length > 0) return;

    const suffix = createHash('sha256')
      .update(`${type}:${key}`)
      .digest('hex')
      .slice(0, 24);
    const prefix = `idx_images_prop_${suffix}`;
    const expression =
      type === 'number'
        ? `CASE WHEN jsonb_typeof(properties->'${key}') = 'number' THEN (properties->>'${key}')::numeric END`
        : type === 'boolean'
          ? `CASE WHEN jsonb_typeof(properties->'${key}') = 'boolean' THEN (properties->>'${key}')::boolean END`
          : type === 'list'
            ? `CASE WHEN jsonb_typeof(properties->'${key}') = 'array' THEN properties->'${key}'->>0 END`
            : `CASE WHEN jsonb_typeof(properties->'${key}') = 'string' THEN properties->>'${key}' END`;
    await pool.query(
      `CREATE INDEX IF NOT EXISTS "${prefix}_sort" ON images (board_id, (${expression}))`,
    );
    if (type === 'list') {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS "${prefix}_has" ON images USING gin ((properties->'${key}') jsonb_path_ops)`,
      );
    }
    await pool.query(
      `INSERT INTO board_property_indexes (board_id, property_key, property_type)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [boardId, key, type],
    );
  })();
  inFlight.set(dedupeKey, work);
  try {
    await work;
  } finally {
    if (inFlight.get(dedupeKey) === work) inFlight.delete(dedupeKey);
  }
}
