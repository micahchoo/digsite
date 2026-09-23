// Storage quotas per group (CONTEXT.md "Storage quota"). A group's usage is
// the bytes of the originals and kept camera sources its boards store,
// each stored object once — storage keeps one object per board per sha256,
// so a picture uploaded twice to one board costs once. Derived files
// (previews, ladder pages, tiles) are the server's, not the group's.
//
// The total is kept, not summed: group_storage.used_bytes moves by exactly
// the bytes of each object written or deleted. `reserve` claims bytes in
// one conditional UPDATE, so two uploads at once cannot both slip past the
// quota; a caller that ends up writing nothing gives them back.
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';

export class QuotaExceeded extends Error {
  constructor(
    readonly usedBytes: number,
    readonly quotaBytes: number,
  ) {
    super('group storage is full');
  }
}

/** The body a refused upload answers with, on every path (multipart,
 * tus): one shape, so one client parser reads both. */
export function quotaRefusal(err: QuotaExceeded) {
  return {
    error: 'group storage is full',
    reason: 'quota',
    usedBytes: err.usedBytes,
    quotaBytes: err.quotaBytes,
  };
}

export type GroupStorage = { usedBytes: number; quotaBytes: number | null };

function defaultQuota(): number | null {
  return env.GROUP_QUOTA_GB > 0 ? Math.round(env.GROUP_QUOTA_GB * 1e9) : null;
}

async function groupOfBoard(boardId: string): Promise<string> {
  const { rows } = await pool.query('SELECT org_id FROM boards WHERE id = $1', [
    boardId,
  ]);
  const orgId = rows[0]?.org_id as string | undefined;
  if (!orgId) throw new Error(`no board ${boardId}`);
  return orgId;
}

export async function storageOf(orgId: string): Promise<GroupStorage> {
  const { rows } = await pool.query(
    'SELECT used_bytes, quota_bytes FROM group_storage WHERE org_id = $1',
    [orgId],
  );
  const row = rows[0];
  const quota =
    row?.quota_bytes === null || row?.quota_bytes === undefined
      ? defaultQuota()
      : Number(row.quota_bytes);
  return { usedBytes: Number(row?.used_bytes ?? 0), quotaBytes: quota };
}

/** Claims `bytes` of the board's group's quota, or throws QuotaExceeded. */
export async function reserve(boardId: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  const orgId = await groupOfBoard(boardId);
  await pool.query(
    'INSERT INTO group_storage (org_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [orgId],
  );
  const { rows } = await pool.query(
    `UPDATE group_storage SET used_bytes = used_bytes + $2
     WHERE org_id = $1
       AND (COALESCE(quota_bytes, $3::bigint) IS NULL
            OR used_bytes + $2 <= COALESCE(quota_bytes, $3::bigint))
     RETURNING used_bytes`,
    [orgId, bytes, defaultQuota()],
  );
  if (rows.length === 0) {
    const { usedBytes, quotaBytes } = await storageOf(orgId);
    throw new QuotaExceeded(usedBytes, quotaBytes ?? 0);
  }
}

/** Gives back bytes: an object deleted, or a reservation not written. */
export async function release(boardId: string, bytes: number): Promise<void> {
  if (bytes <= 0) return;
  const orgId = await groupOfBoard(boardId);
  await pool.query(
    `UPDATE group_storage SET used_bytes = GREATEST(0, used_bytes - $2)
     WHERE org_id = $1`,
    [orgId, bytes],
  );
}
