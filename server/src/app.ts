// Builds the HTTP server (routes mounted, Better Auth mounted, CORS set)
// without listening — index.ts calls `.listen()`; access.test.ts listens on
// an ephemeral port to drive `/_access` for the matrix test. See
// docs/design.md "server/".
import { type Server, createServer } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import {
  AccessDenied,
  boardForCreating,
  boardForCreatingSheet,
  boardForManagingAllowlist,
  boardForUploading,
  boardForViewing,
  boardsForListing,
  groupForInviting,
  groupForViewing,
  imageForViewing,
  sheetForEditing,
} from './access/index.ts';
import { auth } from './auth.ts';
import { registerBoardRoutes } from './boards/routes.ts';
import { isTusPath, tusServer } from './boards/tus.ts';
import { env } from './env.ts';
import { registerGroupRoutes } from './groups/routes.ts';
import { Router, json, param } from './http.ts';
import { mountSheetRoom } from './sheets/room.ts';
import { registerSheetRoutes } from './sheets/routes.ts';

// GET /_access/:intent/:objectId — runs one access function for the
// signed-in user, returns {allowed, reason?, ms}. Test/measurement only,
// not a product route (docs/design.md "src/access/index.ts").
type AccessFn = (userId: string, objectId: string) => Promise<unknown>;
const accessFns: Record<string, AccessFn> = {
  groupForViewing: (u, o) => groupForViewing(u, o),
  groupForInviting: (u, o) => groupForInviting(u, o),
  boardForViewing: (u, o) => boardForViewing(u, o),
  boardForUploading: (u, o) => boardForUploading(u, o),
  boardForCreatingSheet: (u, o) => boardForCreatingSheet(u, o),
  boardForManagingAllowlist: (u, o) => boardForManagingAllowlist(u, o),
  boardForCreating: (u, o) => boardForCreating(u, o),
  sheetForEditing: (u, o) => sheetForEditing(u, o),
  imageForViewing: (u, o) => imageForViewing(u, o),
};

// boardsForListing returns an array, not a single object thrown-or-row, so
// it isn't in accessFns above (a different shape) — exposed separately for
// the same /_access ergonomics under its own intent name.
async function boardsForListingIntent(userId: string, orgId: string) {
  return boardsForListing(userId, orgId);
}
accessFns.boardsForListing = boardsForListingIntent;

export function createHttpServer(): Server {
  const router = new Router();
  registerGroupRoutes(router);
  registerBoardRoutes(router);
  registerSheetRoutes(router);

  router.get('/_access/:intent/:objectId', async (ctx) => {
    if (!ctx.userId) return json(ctx.res, 401, { error: 'unauthorized' });
    const fn = accessFns[param(ctx, 'intent')];
    if (!fn) return json(ctx.res, 404, { error: 'unknown intent' });
    const start = performance.now();
    try {
      await fn(ctx.userId, param(ctx, 'objectId'));
      const ms = performance.now() - start;
      json(ctx.res, 200, { allowed: true, ms });
    } catch (err) {
      const ms = performance.now() - start;
      if (err instanceof AccessDenied) {
        return json(ctx.res, 200, { allowed: false, reason: err.reason, ms });
      }
      throw err;
    }
  });

  const corsHeaders = {
    'Access-Control-Allow-Origin': env.WEB_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  };

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');

    // tus (docs/phases/1-map.md "Upload as a worker") handles its own CORS
    // (Tus-Resumable, Upload-Offset/-Length, Location — allowedOrigins/
    // allowedCredentials/exposedHeaders in boards/tus.ts) and its own
    // OPTIONS response (advertises Tus-Version/-Extension), so it must run
    // before the blanket CORS/OPTIONS handling below, which would otherwise
    // shadow both.
    if (isTusPath(url.pathname)) {
      await tusServer.handle(req, res);
      return;
    }

    for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname.startsWith('/api/auth')) {
      return toNodeHandler(auth)(req, res);
    }
    if (url.pathname.startsWith('/socket.io')) return; // socket.io's own listener

    try {
      const handled = await router.dispatch(req, res);
      if (!handled) json(res, 404, { error: 'not found' });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: String(err) });
    }
  });

  mountSheetRoom(httpServer);
  return httpServer;
}
