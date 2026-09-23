import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_ACTIVE = 128;

const active = new Set<symbol>();
let droppedStarts = 0;

/**
 * Opt-in breadcrumbs for requests that may still be running when the process
 * is killed. Keep the payload deliberately small: selected board/tile ids and
 * process memory are recorded, never query strings, headers, cookies or bodies.
 */
export function startRequestDiagnostic(
  req: IncomingMessage,
  res: ServerResponse,
  details: {
    requestId: string;
    method: string;
    route: string;
    params: Record<string, string>;
  },
): void {
  const isTile = details.route === '/boards/:id/tiles/:sortId/:z/:x/:yfile';
  const isBoardRead = details.route === '/boards/:id';
  if (
    process.env.DIGSITE_REQUEST_DIAGNOSTICS !== '1' ||
    (!isTile && !isBoardRead)
  ) {
    return;
  }

  if (active.size >= MAX_ACTIVE) {
    droppedStarts++;
    return;
  }

  const params = details.params;
  const yFile = params.yfile ?? '';
  const yMatch = /^(-?\d{1,8})\.png$/.exec(yFile);
  const safe: Record<string, string | number | undefined> = {
    boardId: /^[0-9a-f-]{36}$/i.test(params.id ?? '') ? params.id : undefined,
  };
  if (isTile) {
    const sortId = params.sortId ?? '';
    const safeSortId =
      sortId.length <= 128 &&
      /^(?:name|uploaded_at)\.(?:asc|desc)$|^p\.(?:text|number|boolean|date|list)\.[A-Za-z0-9_-]+\.(?:asc|desc)$/.test(
        sortId,
      );
    safe.sortId = safeSortId ? sortId : undefined;
    safe.z = /^-?\d{1,2}$/.test(params.z ?? '') ? Number(params.z) : undefined;
    safe.x = /^\d{1,8}$/.test(params.x ?? '') ? Number(params.x) : undefined;
    safe.y = yMatch ? Number(yMatch[1]) : undefined;
  }
  const startedAt = performance.now();
  const memory = process.memoryUsage();
  const activeKey = Symbol(details.requestId);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    active.delete(activeKey);
    req.off('aborted', close);
    res.off('finish', close);
    res.off('close', close);
    const finalMemory = process.memoryUsage();
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'request-end',
        ts: new Date().toISOString(),
        requestId: details.requestId,
        method: details.method,
        route: details.route,
        outcome: res.writableFinished ? 'finish' : 'close',
        ms: Math.round((performance.now() - startedAt) * 100) / 100,
        activeRequests: active.size,
        memory: {
          rss: finalMemory.rss,
          heapUsed: finalMemory.heapUsed,
          external: finalMemory.external,
          arrayBuffers: finalMemory.arrayBuffers,
        },
      }),
    );
  };
  active.add(activeKey);
  req.once('aborted', close);
  res.once('finish', close);
  res.once('close', close);
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'request-start',
      ts: new Date().toISOString(),
      requestId: details.requestId,
      method: details.method,
      route: details.route,
      params: safe,
      activeRequests: active.size,
      droppedStarts,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
    }),
  );
}

export function activeRequestDiagnosticCount(): number {
  return active.size;
}
