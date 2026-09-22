// The only reads of the plugin's membership tables that are not access
// decisions: lists shown on a page, and the member id a plugin route wants.
// They live beside the intents so the seam holds — see
// ../../../.claude/rules/access-one-function-per-intent.md — and every
// caller has already passed the one access function for its intent.

import type { Pool } from 'pg';
import { pool } from '../db/pool.ts';

export type GroupOfUser = { id: string; name: string; role: string };
export type MemberListed = {
  userId: string;
  email: string;
  name: string;
  role: string;
};

export async function groupsOfUser(
  userId: string,
  db: Pool = pool,
): Promise<GroupOfUser[]> {
  const { rows } = await db.query(
    `SELECT o.id, o.name, m.role FROM "organization" o
     JOIN "member" m ON m."organizationId" = o.id
     WHERE m."userId" = $1 ORDER BY o.name`,
    [userId],
  );
  return rows;
}

export async function membersOfGroup(
  orgId: string,
  db: Pool = pool,
): Promise<MemberListed[]> {
  const { rows } = await db.query(
    `SELECT m."userId", u.email, u.name, m.role FROM "member" m
     JOIN "user" u ON u.id = m."userId"
     WHERE m."organizationId" = $1 ORDER BY u.name`,
    [orgId],
  );
  return rows;
}

/** The plugin's member row id, which its remove-member route wants. */
export async function memberIdOf(
  userId: string,
  orgId: string,
  db: Pool = pool,
): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
    [userId, orgId],
  );
  return rows[0]?.id ?? null;
}

export async function allowlistOf(
  teamId: string,
  db: Pool = pool,
): Promise<{ userId: string }[]> {
  const { rows } = await db.query(
    `SELECT "userId" FROM "teamMember" WHERE "teamId" = $1 ORDER BY "createdAt"`,
    [teamId],
  );
  return rows;
}
