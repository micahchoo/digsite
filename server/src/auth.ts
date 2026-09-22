// Better Auth, mounted at /api/auth/* (src/index.ts). The organization
// plugin is Group+Board (CONTEXT.md): an organization is a Group, a team is
// a private board's allowlist.
//
// The plugin's default `member` role cannot create a team or add/remove a
// team member (better-auth/plugins/organization/access/statement.ts:
// `memberAc` has `team: []` and `member: []`). Our rule is "any member may
// create a board" (CONTEXT.md), including a private one, so `member` is
// widened here to `team: ['create','update','delete']` plus the two
// statements the team-member routes check — `addTeamMember` checks
// `member:update`, `removeTeamMember` checks `member:delete`
// (routes/crud-team.ts, confirmed by reading the source, not guessed).
//
// This is the OUTER line, not the gate: it only keeps the plugin's own
// `createTeam`/`addTeamMember`/`removeTeamMember` calls from 403ing a plain
// member. `src/access/index.ts#boardForManagingAllowlist` (creator, or
// group owner/admin) is what actually decides who may edit an allowlist,
// and it is the only caller of the team-member routes — see
// .claude/rules/access-one-function-per-intent.md.
import { betterAuth } from 'better-auth';
import { createAccessControl, organization } from 'better-auth/plugins';
import { defaultStatements } from 'better-auth/plugins/organization/access';
import { pool } from './db/pool.ts';
import { env } from './env.ts';

// Built fresh from `defaultStatements` rather than importing the plugin's
// own `defaultAc`/`adminAc`/`ownerAc`/`memberAc` singletons: those come back
// from the package typed against `AccessControl` in a way `newRole`'s own
// generic signature doesn't accept back (a `tsc` mismatch, not a runtime
// one) — recreating the same statements locally sidesteps it.
const ac = createAccessControl(defaultStatements);

const adminRole = ac.newRole({
  organization: ['update'],
  invitation: ['create', 'cancel'],
  member: ['create', 'update', 'delete'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
});

const ownerRole = ac.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
});

const widenedMemberAc = ac.newRole({
  organization: [],
  member: ['update', 'delete'],
  invitation: [],
  team: ['create', 'update', 'delete'],
  ac: ['read'],
});

// has-permission.ts resolves roles from `options.roles || defaultRoles` —
// unlike organization.ts's own `{...defaultRoles, ...opts.roles}`, this one
// does NOT merge. Passing only `{ member: widened }` would make `admin` and
// `owner` resolve to `undefined` in every hasPermission call, breaking every
// owner/admin action in the plugin. All three roles must be listed.

export const auth = betterAuth({
  database: pool,
  secret: env.AUTH_SECRET,
  baseURL: env.SERVER_ORIGIN,
  trustedOrigins: [env.WEB_ORIGIN],
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    organization({
      teams: { enabled: true, defaultTeam: { enabled: false } },
      invitationExpiresIn: env.INVITATION_EXPIRES_IN,
      ac,
      roles: {
        admin: adminRole,
        owner: ownerRole,
        member: widenedMemberAc,
      },
    }),
  ],
});
