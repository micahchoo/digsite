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
import { registerHealthRoutes } from './health.ts';
import { Router, json, param } from './http.ts';
import { logError, logRequest, requestIdFor } from './logging.ts';
import { registerMetricsRoutes } from './metrics.ts';
import { mountSheetRoom } from './sheets/room.ts';
import { registerSheetRoutes } from './sheets/routes.ts';
import { registerSiteRoutes } from './site/routes.ts';

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

export type HttpServerOptions = {
  /** Overrides GET /metrics's token (default env.METRICS_TOKEN) — for
   * metrics.test.ts, which otherwise has no reliable way to set it (env.ts
   * reads process.env once, at first import, and an earlier-loading test
   * file has almost always already imported it — see that test's own
   * comment). Product code never passes this. */
  metricsToken?: string;
};

/** Builds and registers every route without starting anything — the one
 * place the full route set is assembled, so
 * server/src/test/routes-audit.test.ts can enumerate it (`Router#routes()`)
 * without also standing up Socket.IO or listening on a port.
 * `createHttpServer` below is the only caller in product code. */
export function buildRouter(opts: HttpServerOptions = {}): Router {
  const router = new Router();
  registerHealthRoutes(router);
  registerGroupRoutes(router);
  registerBoardRoutes(router);
  registerSheetRoutes(router);
  registerSiteRoutes(router);
  registerMetricsRoutes(router, opts.metricsToken ?? env.METRICS_TOKEN);

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

  return router;
}

export function createHttpServer(opts: HttpServerOptions = {}): Server {
  const router = buildRouter(opts);

  const corsHeaders = {
    'Access-Control-Allow-Origin': env.WEB_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Expose-Headers':
      'X-Request-Id, Retry-After, X-Order-Version',
  };

  const httpServer = createServer(async (req, res) => {
    // Phase 5 section 4 (docs/phases/5-hardening.md "Operability"): one
    // request id for the whole request, generated once here (or read off
    // an incoming X-Request-Id) so the response header and every log line
    // below agree. `router.dispatch` logs its own matched-route line
    // (http.ts); the four branches below it are the paths dispatch never
    // sees (tus, CORS preflight, /api/auth, an unmatched path) and log
    // their own single line each, so every request gets exactly one.
    const requestId = requestIdFor(req);
    res.setHeader('X-Request-Id', requestId);
    const start = performance.now();
    const url = new URL(req.url ?? '/', 'http://internal');

    // tus (docs/phases/1-map.md "Upload as a worker") handles its own CORS
    // (Tus-Resumable, Upload-Offset/-Length, Location — allowedOrigins/
    // allowedCredentials/exposedHeaders in boards/tus.ts) and its own
    // OPTIONS response (advertises Tus-Version/-Extension), so it must run
    // before the blanket CORS/OPTIONS handling below, which would otherwise
    // shadow both.
    if (isTusPath(url.pathname)) {
      // Completion can occur before handle() resolves, especially PATCH.
      // Register first so accepted or rejected chunks cannot disappear from logs.
      res.once('finish', () =>
        logRequest({
          requestId,
          method: req.method ?? '',
          route: '(tus)',
          status: res.statusCode,
          ms: performance.now() - start,
          userId: null,
        }),
      );
      await tusServer.handle(req, res);
      return;
    }

    for (const [k, v] of Object.entries(corsHeaders)) res.setHeader(k, v);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      logRequest({
        requestId,
        method: 'OPTIONS',
        route: '(cors-preflight)',
        status: 204,
        ms: performance.now() - start,
        userId: null,
      });
      return;
    }

    if (url.pathname.startsWith('/api/auth')) {
      await toNodeHandler(auth)(req, res);
      logRequest({
        requestId,
        method: req.method ?? '',
        // Not the raw pathname: a sign-in/sign-up path is Better Auth's
        // own concern and this label must stay low-cardinality (see
        // metrics.ts's header comment on '(unmatched)') — one series for
        // the whole surface is enough for "is auth up and how slow".
        route: '(auth)',
        status: res.statusCode,
        ms: performance.now() - start,
        userId: null,
      });
      return;
    }
    if (url.pathname.startsWith('/socket.io')) return; // socket.io's own listener

    try {
      const handled = await router.dispatch(req, res, requestId);
      if (!handled) {
        json(res, 404, { error: 'not found' });
        logRequest({
          requestId,
          method: req.method ?? '',
          route: '(unmatched)',
          status: 404,
          ms: performance.now() - start,
          userId: null,
        });
      }
    } catch (err) {
      // router.dispatch only throws here for something outside its own
      // try/catch (a handler threw during a response that was never
      // reached, e.g. matching itself) — dispatch's own handler errors are
      // already logged and turned into a 500 inside it.
      logError(err, requestId, url.pathname);
      if (!res.headersSent)
        json(res, 500, { error: 'internal error', requestId });
      logRequest({
        requestId,
        method: req.method ?? '',
        route: '(error)',
        status: res.statusCode,
        ms: performance.now() - start,
        userId: null,
      });
    }
  });

  mountSheetRoom(httpServer);
  return httpServer;
}
