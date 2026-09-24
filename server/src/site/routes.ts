// The site, not a group: what its operator (env.OPERATOR_EMAILS) may do.
// Today that is recovery: a person who forgot their password gets a new
// one from the operator, and every session they had ends. Nothing here
// sends email; the operator hands the new password over themselves.
import type {
  ListAccountsResponse,
  OperatorResponse,
  SetAccountPasswordRequest,
  SetAccountPasswordResponse,
} from '@digsite/shared/api';
import { userForOperating } from '../access/index.ts';
import { accountsForOperating } from '../access/reads.ts';
import { auth } from '../auth.ts';
import { pool } from '../db/pool.ts';
import {
  type Router,
  json,
  param,
  readJsonBody,
  requireAuth,
} from '../http.ts';

export function registerSiteRoutes(router: Router) {
  router.get('/operator', async (ctx) => {
    await userForOperating(requireAuth(ctx));
    const response: OperatorResponse = { operator: true };
    json(ctx.res, 200, response);
  });

  router.get('/operator/accounts', async (ctx) => {
    await userForOperating(requireAuth(ctx));
    const response: ListAccountsResponse = await accountsForOperating();
    json(ctx.res, 200, response);
  });

  router.post('/operator/accounts/:id/password', async (ctx) => {
    await userForOperating(requireAuth(ctx));
    const accountId = param(ctx, 'id');
    const body = (await readJsonBody(ctx.req)) as SetAccountPasswordRequest;
    const context = await auth.$context;
    const { minPasswordLength, maxPasswordLength } = context.password.config;
    const password = typeof body.password === 'string' ? body.password : '';
    if (
      password.length < minPasswordLength ||
      password.length > maxPasswordLength
    ) {
      return json(ctx.res, 400, {
        reason: `a password is ${minPasswordLength} to ${maxPasswordLength} characters`,
      });
    }
    const { rows } = await pool.query(
      `SELECT 1 FROM "account"
       WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [accountId],
    );
    if (rows.length === 0) {
      return json(ctx.res, 404, { reason: 'no account with a password' });
    }
    await context.internalAdapter.updatePassword(
      accountId,
      await context.password.hash(password),
    );
    // Sessions live only in Postgres here (no secondary storage), so this
    // is every session the person has. The internal adapter's
    // deleteSessions does the same for a string, but its type says it
    // takes only tokens.
    await pool.query('DELETE FROM "session" WHERE "userId" = $1', [accountId]);
    const response: SetAccountPasswordResponse = { signedOut: true };
    json(ctx.res, 200, response);
  });
}
