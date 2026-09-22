import type {
  AcceptInvitationResponse,
  CreateGroupRequest,
  CreateGroupResponse,
  InviteRequest,
  InviteResponse,
  ListGroupsResponse,
  ListMembersResponse,
  Role,
} from '@digsite/shared/api';
// Groups (CONTEXT.md "Group"): a Better Auth organization. Routes call
// auth.api.* for the plugin's own flows (create/invite/accept/leave/remove)
// and access/index.ts for everything the plugin doesn't gate — see
// docs/design.md "Routes / Groups".
import { fromNodeHeaders } from 'better-auth/node';
import { groupForInviting, groupForViewing } from '../access/index.ts';
import { auth } from '../auth.ts';
import { pool } from '../db/pool.ts';
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
    const { rows } = await pool.query(
      `SELECT o.id, o.name, m.role FROM "organization" o
       JOIN "member" m ON m."organizationId" = o.id
       WHERE m."userId" = $1 ORDER BY o.name`,
      [userId],
    );
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
    const { rows } = await pool.query(
      `SELECT m."userId", u.email, u.name, m.role FROM "member" m
       JOIN "user" u ON u.id = m."userId"
       WHERE m."organizationId" = $1 ORDER BY u.name`,
      [orgId],
    );
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
    const response: InviteResponse = { invitationId: invitation?.id };
    json(ctx.res, 200, response);
  });

  router.post('/invitations/:id/accept', async (ctx) => {
    requireAuth(ctx);
    const invitationId = param(ctx, 'id');
    const result = await auth.api.acceptInvitation({
      body: { invitationId },
      headers: fromNodeHeaders(ctx.req.headers),
    });
    const response: AcceptInvitationResponse = {
      groupId: result?.invitation.organizationId,
    };
    json(ctx.res, 200, response);
  });

  router.post('/groups/:id/leave', async (ctx) => {
    requireAuth(ctx);
    const orgId = param(ctx, 'id');
    await auth.api.leaveOrganization({
      body: { organizationId: orgId },
      headers: fromNodeHeaders(ctx.req.headers),
    });
    json(ctx.res, 200, {});
  });

  router.del('/groups/:id/members/:userId', async (ctx) => {
    const userId = requireAuth(ctx);
    const orgId = param(ctx, 'id');
    const targetUserId = param(ctx, 'userId');
    await groupForInviting(userId, orgId);
    const { rows } = await pool.query(
      `SELECT id FROM "member" WHERE "userId" = $1 AND "organizationId" = $2`,
      [targetUserId, orgId],
    );
    if (!rows[0]) return json(ctx.res, 404, { error: 'member not found' });
    await auth.api.removeMember({
      body: { memberIdOrEmail: rows[0].id, organizationId: orgId },
      headers: fromNodeHeaders(ctx.req.headers),
    });
    json(ctx.res, 200, { ok: true });
  });
}
