// A board's terms and aliases (CONTEXT.md "Making sense"). The vocabulary
// is read from claim rows every time, never stored: the rows are the fact,
// and a stored list would drift the moment a sheet saved. Aliases are the
// one thing stored, and only here. Every reader that matches a term (find,
// neighbourhood) expands it through `aliasesOf` + `termsMeaning`, so a
// term means the same thing wherever it is asked.
import type { GetBoardVocabularyResponse } from '@digsite/shared/api';
import {
  type Aliases,
  type TermKind,
  buildVocabulary,
  withAlias,
} from '@digsite/shared/sheet/sense';
import type { Pool, PoolClient } from 'pg';
import { pool } from '../db/pool.ts';

export async function aliasesOf(
  boardId: string,
  db: Pool | PoolClient = pool,
): Promise<Aliases> {
  const { rows } = await db.query<{
    kind: TermKind;
    term: string;
    canonical: string;
  }>('SELECT kind, term, canonical FROM term_aliases WHERE board_id = $1', [
    boardId,
  ]);
  const aliases: {
    label: Record<string, string>;
    relation: Record<string, string>;
  } = { label: {}, relation: {} };
  for (const r of rows) aliases[r.kind][r.term] = r.canonical;
  return aliases;
}

export async function vocabularyOf(
  boardId: string,
): Promise<GetBoardVocabularyResponse> {
  const [aliases, labels, relations] = await Promise.all([
    aliasesOf(boardId),
    pool.query<{ term: string; n: number }>(
      `SELECT r.label AS term, count(*)::int AS n FROM regions r
       JOIN sheets s ON s.id = r.sheet_id
       WHERE s.board_id = $1 AND r.label != ''
       GROUP BY r.label`,
      [boardId],
    ),
    pool.query<{ term: string; n: number }>(
      `SELECT e.relation AS term, count(*)::int AS n FROM edges e
       JOIN sheets s ON s.id = e.sheet_id
       WHERE s.board_id = $1 AND e.relation != ''
       GROUP BY e.relation`,
      [boardId],
    ),
  ]);
  return {
    labels: buildVocabulary(
      labels.rows.map((r) => [r.term, r.n] as const),
      aliases.label,
    ),
    relations: buildVocabulary(
      relations.rows.map((r) => [r.term, r.n] as const),
      aliases.relation,
    ),
    aliases,
  };
}

/** `term` now means `canonical`. Rewrites the board's alias rows of that
 * kind to `withAlias`'s flat map in one transaction, so two people merging
 * at once can never leave a chain. False for a self-alias. */
export async function putAlias(
  boardId: string,
  kind: TermKind,
  term: string,
  canonical: string,
  userId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialises alias writes per board and kind.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `aliases:${boardId}:${kind}`,
    ]);
    const current = (await aliasesOf(boardId, client))[kind];
    const next = withAlias(current, term, canonical);
    if (!next) {
      await client.query('ROLLBACK');
      return false;
    }
    for (const [alias, target] of Object.entries(next)) {
      if (current[alias] === target) continue;
      await client.query(
        `INSERT INTO term_aliases (board_id, kind, term, canonical, created_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (board_id, kind, term)
         DO UPDATE SET canonical = $4, created_by = $5, created_at = now()`,
        [boardId, kind, alias, target, userId],
      );
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAlias(
  boardId: string,
  kind: TermKind,
  term: string,
): Promise<void> {
  await pool.query(
    'DELETE FROM term_aliases WHERE board_id = $1 AND kind = $2 AND term = $3',
    [boardId, kind, term],
  );
}
