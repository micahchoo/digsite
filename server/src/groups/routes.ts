import type {
  AcceptInvitationResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  GetInvitationResponse,
  InviteRequest,
  InviteResponse,
  ListGroupsResponse,
  ListMembersResponse,
  ListPendingInvitationsResponse,
  ListRecentSheetsResponse,
  Role,
  UpdateMemberRoleRequest,
  UpdateMemberRoleResponse,
} from '@digsite/shared/api';
// Groups (CONTEXT.md "Group"): a Better Auth organization. Routes call
// auth.api.* for the plugin's own flows (create/invite/accept/leave/remove)
// and access/index.ts for everything the plugin doesn't gate — see
// docs/design.md "Routes / Groups".
import { APIError } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';
import {
  boardsForListing,
  groupForInviting,
  groupForManagingMembers,
  groupForViewing,
} from '../access/index.ts';
import { groupsOfUser, memberIdOf, membersOfGroup } from '../access/reads.ts';
import { auth } from '../auth.ts';
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import {
  type Router,
  json,
  param,
  readJsonBody,
  requireAuth,
} from '../http.ts';

function slugify(name: string): string {
  return `${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${Math.random().toString(36).slice(2, 8)}`;
}

/** auth.api.* throws better-auth's own APIError (statusCode + body.message)
 * on a plugin-level refusal — the sole-owner guards on leave/remove/
 * update-role, "not the recipient", an already-used invitation, and so on
 * (see this module's callers and .claude/rules/
 * access-one-function-per-intent.md's "what the plugin does" section).
 * Turned into this route layer's own `{reason}` shape instead of a bare
 * 500, since every one of these is a legitimate 4xx a client should show. */
function authApiErrorResponse(
  err: unknown,
): { status: number; reason: string } | null {
  if (!(err instanceof APIError)) return null;
  const body = err.body as { message?: string; code?: string } | undefined;
  return {
    status: err.statusCode,
    reason: body?.message ?? body?.code ?? 'request failed',
  };
}

export function registerGroupRoutes(router: Router) {
  router.post('/groups', async (ctx) => {
    const userId = requireAuth(ctx);
    const body = (await readJsonBody(ctx.req)) as CreateGroupRequest;
    const org = await auth.api.createOrganization({
      body: { name: body.name, slug: slugify(body.name) },
      headers: fromNodeHeaders(ctx.req.headers),
    });
    const response: CreateGroupResponse = { id: org?.id };
    json(ctx.res, 200, response);
  });

  router.get('/groups', async (ctx) => {
    const userId = requireAuth(ctx);
    const rows = await groupsOfUser(userId);
    const response: ListGroupsResponse = rows.map((r) => ({
      id: r.id,
      name: r.name,
      role: r.role as Role,
    }));
    json(ctx.res, 200, response);
  });

  router.get('/groups/:id/members', async (ctx) => {
    const userId = requireAuth(ctx);
    const orgId = param(ctx, 'id');
    await groupForViewing(userId, orgId);
    const rows = await membersOfGroup(orgId);
    const response: ListMembersResponse = rows.map((r) => ({
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role as Role,
    }));
    json(ctx.res, 200, response);
  });

  router.post('/groups/:id/invite', async (ctx) => {
    const userId = requireAuth(ctx);
    const orgId = param(ctx, 'id');
    await groupForInviting(userId, orgId);
    const body = (await readJsonBody(ctx.req)) as InviteRequest;
    const invitation = await auth.api.createInvitation({
      body: { email: body.email, role: 'member', organizationId: orgId },
      headers: fromNodeHeaders(ctx.req.headers),
    });
    // docs/phases/3-groups.md section 1: the join page's URL, so the caller
    // never has to build `/join/<id>` itself. Stub-vs-doc: the doc spells
    // the request body `{email?}` (invite by link, no named recipient); kept
    // required here (matches the pre-existing InviteRequest shape and
    // seed.ts/access.test.ts's own calls) because better-auth's own
    // accept-invitation endpoint refuses when the invitation's email
    // doesn't match the accepting session's email
    // (YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION) — an emailless invite
    // could never be accepted through this plugin. See this task's report.
    const response: InviteResponse = {
      invitationId: invitation?.id,
      url: `${env.WEB_ORIGIN}/join/${invitation?.id}`,
    };
    json(ctx.res, 200, response);
  });

  // GET /invitations/:id — public, no session (docs/phases/3-groups.md
  // section 1's join preview before signing in or up). Reads the plugin's
  // own `invitation`/`organization`/`user` tables directly: better-auth's
  // own `getInvitation` endpoint requires a session AND that the session's
  // email match the invitation's (crud-invites.mjs), which is exactly what
  // an unauthenticated preview cannot offer.
  router.get('/invitations/:id', async (ctx) => {
    const invitationId = param(ctx, 'id');
    const { rows } = await pool.query(
      `SELECT i.status, i."expiresAt" AS expires_at,
              o.name AS group_name, u.name AS inviter_name
       FROM "invitation" i
       JOIN "organization" o ON o.id = i."organizationId"
       JOIN "user" u ON u.id = i."inviterId"
       WHERE i.id = $1`,
      [invitationId],
    );
    const row = rows[0];
    if (!row) return json(ctx.res, 404, { reason: 'not found' });
    const open =
      row.status === 'pending' && new Date(row.expires_at) > new Date();
    const response: GetInvitationResponse = {
      groupName: row.group_name,
      inviterName: row.inviter_name,
      open,
    };
    json(ctx.res, 200, response);
  });

  router.get('/groups/:id/invitations', async (ctx) => {
    const userId = requireAuth(ctx);
    const orgId = param(ctx, 'id');
    await groupForInviting(userId, orgId);
    const list = (await auth.api.listInvitations({
      query: { organizationId: orgId },
      headers: fromNodeHeaders(ctx.req.headers),
    })) as {
      id: string;
      email: string;
      status: string;
      expiresAt: string | Date;
      createdAt?: string | Date;
    }[];
    const now = new Date();
    const pending = (list ?? []).filter(
      (i) => i.status === 'pending' && new Date(i.expiresAt) > now,
    );
    const response: ListPendingInvitationsResponse = pending.map((i) => ({
      id: i.id,
      email: i.email ?? null,
      createdAt: new Date(i.createdAt ?? now).toISOString(),
    }));
    json(ctx.res, 200, response);
  });

  router.del('/invitations/:id', async (ctx) => {
    const userId = requireAuth(ctx);
    const invitationId = param(ctx, 'id');
    const { rows } = await pool.query(
      `SELECT "organizationId" FROM "invitation" WHERE id = $1`,
      [invitationId],
    );
    const orgId = rows[0]?.organizationId as string | undefined;
    if (!orgId) return json(ctx.res, 404, { reason: 'not found' });
    await groupForInviting(userId, orgId);
    try {
      await auth.api.cancelInvitation({
        body: { invitationId },
        headers: fromNodeHeaders(ctx.req.headers),
      });
    } catch (err) {
      const mapped = authApiErrorResponse(err);
      if (mapped)
        return json(ctx.res, mapped.status, { reason: mapped.reason });
      throw err;
    }
    json(ctx.res, 200, {});
  });

  router.post('/invitations/:id/accept', async (ctx) => {
    requireAuth(ctx);
    const invitationId = param(ctx, 'id');
    try {
      const result = await auth.api.acceptInvitation({
        body: { invitationId },
        headers: fromNodeHeaders(ctx.req.headers),
      });
      const response: AcceptInvitationResponse = {
        groupId: result?.invitation.organizationId,
      };
      json(ctx.res, 200, response);
    } catch (err) {
      // docs/phases/3-groups.md section 1: one message for both an expired
      // and an already-used invitation — the plugin returns the same
      // INVITATION_NOT_FOUND for both (byte-identical, confirmed in
      // ../../../prototype/groups/RESULTS.md), so there is nothing more
      // specific to tell the caller here even if we wanted to.
      if (err instanceof APIError) {
        const body = err.body as { code?: string } | undefined;
        if (body?.code === 'INVITATION_NOT_FOUND') {
          return json(ctx.res, 400, {
            reason: 'This invitation is no longer open.',
          });
        }
      }
      const mapped = authApiErrorResponse(err);
      if (mapped)
        return json(ctx.res, mapped.status, { reason: mapped.reason });
      throw err;
    }
  });

  router.post('/groups/:id/leave', async (ctx) => {
    requireAuth(ctx);
    const orgId = param(ctx, 'id');
    try {
      await auth.api.leaveOrganization({
        body: { organizationId: orgId },
        headers: fromNodeHeaders(ctx.req.headers),
      });
    } catch (err) {
      // docs/phases/3-groups.md section 2: "an owner cannot leave while
      // sole owner" — the plugin's own leaveOrganization already refuses
      // this (YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER, 400),
      // so there is nothing to re-implement here, only to translate.
      const mapped = authApiErrorResponse(err);
      if (mapped)
        return json(ctx.res, mapped.status, { reason: mapped.reason });
      throw err;
    }
    json(ctx.res, 200, {});
  });

  router.patch('/groups/:id/members/:userId', async (ctx) => {
    const userId = requireAuth(ctx);
    const orgId = param(ctx, 'id');
    const targetUserId = param(ctx, 'userId');
    await groupForManagingMembers(userId, orgId);
    const body = (await readJsonBody(ctx.req)) as UpdateMemberRoleRequest;
    const memberId = await memberIdOf(targetUserId, orgId);
    if (!memberId) return json(ctx.res, 404, { reason: 'member not found' });
    try {
      // docs/phases/3-groups.md section 2: "only an owner may make or
      // unmake an owner" — the plugin's own update-member-role already
      // refuses a non-owner touching an owner role either direction
      // (YOU_ARE_NOT_ALLOWED_TO_UPDATE_THIS_MEMBER, crud-members.mjs), so
      // groupForManagingMembers only needs to gate "may touch members at
      // all" (owner or admin); this finer rule is the plugin's, translated
      // below like every other auth.api.* refusal in this file.
      await auth.api.updateMemberRole({
        body: { memberId, role: body.role, organizationId: orgId },
        headers: fromNodeHeaders(ctx.req.headers),
      });
    } catch (err) {
      const mapped = authApiErrorResponse(err);
      if (mapped)
        return json(ctx.res, mapped.status, { reason: mapped.reason });
      throw err;
    }
    const response: UpdateMemberRoleResponse = {
      userId: targetUserId,
      role: body.role,
    };
    json(ctx.res, 200, response);
  });

  router.del('/groups/:id/members/:userId', async (ctx) => {
    const userId = requireAuth(ctx);
    const orgId = param(ctx, 'id');
    const targetUserId = param(ctx, 'userId');
    await groupForManagingMembers(userId, orgId);
    const memberId = await memberIdOf(targetUserId, orgId);
    if (!memberId) return json(ctx.res, 404, { reason: 'member not found' });
    try {
      await auth.api.removeMember({
        body: { memberIdOrEmail: memberId, organizationId: orgId },
        headers: fromNodeHeaders(ctx.req.headers),
      });
    } catch (err) {
      const mapped = authApiErrorResponse(err);
      if (mapped)
        return json(ctx.res, mapped.status, { reason: mapped.reason });
      throw err;
    }
    json(ctx.res, 200, { ok: true });
  });

  // GET /groups/:id/sheets/recent (docs/phases/3-groups.md section 5): the
  // group home's cross-board recent list. `boardsForListing` is the one
  // query for "boards this user can see in this group" — see
  // .claude/rules/access-one-function-per-intent.md — so this is that same
  // visible set, joined to sheets, never a per-board boardForViewing loop.
  router.get('/groups/:id/sheets/recent', async (ctx) => {
    const userId = requireAuth(ctx);
    const orgId = param(ctx, 'id');
    const boards = await boardsForListing(userId, orgId);
    if (boards.length === 0) {
      const response: ListRecentSheetsResponse = [];
      return json(ctx.res, 200, response);
    }
    const ids = boards.map((b) => b.id);
    const nameById = new Map(boards.map((b) => [b.id, b.name]));
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.board_id, ss.saved_at FROM sheets s
       LEFT JOIN sheet_snapshots ss ON ss.sheet_id = s.id
       WHERE s.board_id = ANY($1::uuid[])
       ORDER BY ss.saved_at DESC NULLS LAST
       LIMIT 10`,
      [ids],
    );
    const response: ListRecentSheetsResponse = rows.map((r) => ({
      id: r.id,
      name: r.name,
      boardId: r.board_id,
      boardName: nameById.get(r.board_id) ?? '',
      savedAt: r.saved_at ? r.saved_at.toISOString() : null,
    }));
    json(ctx.res, 200, response);
  });
}
