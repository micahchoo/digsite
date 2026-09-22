// A minimal router over node:http, shared by every routes.ts. Not a
// framework: pattern matching, JSON in/out, and the one thing every route
// needs before it does anything else — the signed-in user's id.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import { AccessDenied } from './access/index.ts';
import { auth } from './auth.ts';

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  userId: string | null;
};

export type Handler = (ctx: Ctx) => Promise<void>;

type Route = {
  method: string;
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
  private routes: Route[] = [];

  private add(method: string, pattern: string, handler: Handler) {
    const { re, keys } = compile(pattern);
    this.routes.push({ method, re, keys, handler });
  }

  get(pattern: string, handler: Handler) {
    this.add('GET', pattern, handler);
  }
  post(pattern: string, handler: Handler) {
    this.add('POST', pattern, handler);
  }
  patch(pattern: string, handler: Handler) {
    this.add('PATCH', pattern, handler);
  }
  del(pattern: string, handler: Handler) {
    this.add('DELETE', pattern, handler);
  }

  /** Returns true if a route matched (and ran); false otherwise. */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://internal');
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const m = route.re.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1] ?? '');
      });
      const userId = await sessionUserId(req);
      const ctx: Ctx = { req, res, url, params, userId };
      try {
        await route.handler(ctx);
      } catch (err) {
        if (err instanceof StopHandling) return true;
        if (err instanceof AccessDenied) {
          json(res, 403, { reason: err.reason });
          return true;
        }
        console.error(`[${route.method} ${url.pathname}]`, err);
        json(res, 500, { error: String(err) });
        return true;
      }
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
