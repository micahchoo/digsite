// Better Auth's React client. The organization plugin is loaded because the
// server mounts it (docs/design.md server/src/auth.ts), but web's own group
// and board membership calls go through api.ts's plain REST routes, not the
// plugin's own /organization/* actions — see docs/design.md "Routes".
import { organizationClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { SERVER_ORIGIN } from './api.ts';

export const authClient = createAuthClient({
  baseURL: SERVER_ORIGIN,
  plugins: [organizationClient()],
});

export const { useSession, signIn, signUp, signOut } = authClient;
