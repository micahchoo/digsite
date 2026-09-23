// A minimal router over node:http, shared by every routes.ts. Not a
// framework: pattern matching, JSON in/out, and the one thing every route
// needs before it does anything else — the signed-in user's id.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import { AccessDenied } from './access/index.ts';
import { auth } from './auth.ts';
import { logError, logRequest, requestIdFor } from './logging.ts';
import { startRequestDiagnostic } from './request-diagnostics.ts';

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  userId: string | null;
  // Phase 5 section 4 (docs/phases/5-hardening.md): generated once per
  // request (or passed through via X-Request-Id — logging.ts), so a
  // handler that wants it in its own error path can reach it without
  // re-deriving it from `req`.
  requestId: string;
};

export type Handler = (ctx: Ctx) => Promise<void>;

type Route = {
  method: string;
  pattern: string;
  keys: string[];
  re: RegExp;
  handler: Handler;
};

function compile(pattern: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const re = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${re}$`), keys };
}

export class Router {
  private entries: Route[] = [];

  private add(method: string, pattern: string, handler: Handler) {
    const { re, keys } = compile(pattern);
    this.entries.push({ method, pattern, re, keys, handler });
  }

  /** Every registered route, method + pattern only — read-only, for
   * server/src/test/routes-audit.test.ts (docs/phases/5-hardening.md
   * section 1: "a new route with neither [401 nor 403 coverage] fails the
   * build"). No handler, no regex: enumerating routes must not let a test
   * accidentally call one directly and skip the real dispatch path (auth,
   * CORS, logging) a browser or curl would go through. */
  routes(): { method: string; pattern: string }[] {
    return this.entries.map((r) => ({ method: r.method, pattern: r.pattern }));
  }

  get(pattern: string, handler: Handler) {
    this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler) {
    this.add('POST', pattern, handler);
  }
  put(pattern: string, handler: Handler) {
    this.add('PUT', pattern, handler);
  }
  patch(pattern: string, handler: Handler) {
    this.add('PATCH', pattern, handler);
  }
  del(pattern: string, handler: Handler) {
    this.add('DELETE', pattern, handler);
  }

  /** Returns true if a route matched (and ran); false otherwise. A request
   * id is generated (or read off X-Request-Id — logging.ts) when the
   * caller doesn't already have one; app.ts's own top-level handler passes
   * one through so the same id appears in its `X-Request-Id` response
   * header and this function's log line. One structured log line per
   * matched request either way (docs/phases/5-hardening.md section 4) —
   * app.ts logs the unmatched (404), tus and /api/auth cases itself, since
   * this function never sees those. */
  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string = requestIdFor(req),
  ): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://internal');
    for (const route of this.entries) {
      if (route.method !== req.method) continue;
      const m = route.re.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      startRequestDiagnostic(req, res, {
        requestId,
        method: route.method,
        route: route.pattern,
        params,
      });
      const userId = await sessionUserId(req);
      const ctx: Ctx = { req, res, url, params, userId, requestId };
      const start = performance.now();
      const finish = () => {
        logRequest({
          requestId,
          method: route.method,
          route: route.pattern,
          status: res.statusCode,
          ms: performance.now() - start,
          userId,
          serverTiming: res.getHeader('Server-Timing'),
        });
      };
      try {
        await route.handler(ctx);
      } catch (err) {
        if (err instanceof StopHandling) {
          finish();
          return true;
        }
        if (err instanceof AccessDenied) {
          // docs/ux/audit.md #7 / docs/ux/design.md: {reason, askName} on a
          // board denial when the access function decided the viewer may be
          // told whom to ask (access/index.ts#boardForViewing); every other
          // denial stays a plain {reason} — this is the one place that
          // shape difference becomes JSON, so no route hand-writes it.
          json(
            res,
            403,
            err.askName
              ? { reason: err.reason, askName: err.askName }
              : { reason: err.reason },
          );
          finish();
          return true;
        }
        // A 500 never leaks a stack (or even the raw error message) to the
        // client — the stack goes to the structured error log, keyed by
        // the same requestId the response header carries, so an operator
        // can find it without the client having exposed anything.
        logError(err, requestId, `${route.method} ${route.pattern}`);
        json(res, 500, { error: 'internal error', requestId });
        finish();
        return true;
      }
      finish();
      return true;
    }
    return false;
  }
}

export async function sessionUserId(
  req: IncomingMessage,
): Promise<string | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });
  return session?.user.id ?? null;
}

export function requireAuth(ctx: Ctx): string {
  if (!ctx.userId) {
    json(ctx.res, 401, { error: 'unauthorized' });
    throw new StopHandling();
  }
  return ctx.userId;
}

/** A route param, guaranteed present by the router's own pattern match —
 * one checked lookup here instead of a `ctx.params.x!` at every call site. */
export function param(ctx: Ctx, name: string): string {
  const v = ctx.params[name];
  if (v === undefined) throw new Error(`missing route param: ${name}`);
  return v;
}

/** Thrown to unwind out of a handler after a response was already sent. */
export class StopHandling extends Error {}

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** Builds a web-standard Request from a node IncomingMessage, body included,
 * so a route can call `.formData()` for multipart uploads. */
export async function toWebRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url ?? '/', 'http://internal');
  return new Request(url.toString(), {
    method: req.method,
    headers,
    body: body.length ? body : undefined,
  });
}
