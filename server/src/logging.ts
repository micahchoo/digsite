// Phase 5 section 4 (docs/phases/5-hardening.md "Operability"): one
// structured JSON line per request (route, status, ms, user id, the
// Server-Timing parts when the response carried one) and one for an error
// (message + stack, keyed by the same request id the client's
// `X-Request-Id` response header carries — never sent to the client
// itself, see http.ts's 500 handler). `logRequest` also feeds
// metrics.ts#recordRequest: one call site per finished request, not two,
// so a new caller can't add logging and forget metrics or the reverse.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { recordRequest } from './metrics.ts';

/** X-Request-Id, passed through when the caller already has one (a proxy
 * upstream, a retried request, a test asserting on it) — generated
 * otherwise. Bounded and stringified defensively: this becomes a log field
 * and a response header, never trusted for anything else. */
export function requestIdFor(req: IncomingMessage): string {
  const header = req.headers['x-request-id'];
  const passed = Array.isArray(header) ? header[0] : header;
  if (passed && passed.length > 0 && passed.length <= 200) return passed;
  return randomUUID();
}

type RequestLogEntry = {
  requestId: string;
  method: string;
  route: string;
  status: number;
  ms: number;
  userId: string | null;
  serverTiming?: string | number | string[] | undefined;
};

export function logRequest(entry: RequestLogEntry): void {
  console.log(
    JSON.stringify({
      level: 'info',
      ts: new Date().toISOString(),
      requestId: entry.requestId,
      method: entry.method,
      route: entry.route,
      status: entry.status,
      ms: Math.round(entry.ms * 100) / 100,
      userId: entry.userId,
      ...(entry.serverTiming ? { serverTiming: entry.serverTiming } : {}),
    }),
  );
  recordRequest(entry.method, entry.route, entry.status, entry.ms);
}

export function logError(err: unknown, requestId: string, route: string): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(
    JSON.stringify({
      level: 'error',
      ts: new Date().toISOString(),
      requestId,
      route,
      message,
      stack,
    }),
  );
}
