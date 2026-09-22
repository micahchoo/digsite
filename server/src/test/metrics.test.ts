import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
// Phase 5 section 4 (docs/phases/5-hardening.md "Operability"): GET
// /metrics is 404 with no token configured (or the wrong one), 200
// text/plain with the right one — request counts/latency, tile cache
// counters, worker queue depth, sheet rooms/peers.
//
// `createHttpServer({metricsToken})` (app.ts), not env.METRICS_TOKEN
// directly: env.ts reads process.env once, at first import, and `bun
// test` runs every file in one shared process, so by the time this file's
// module body ran, an earlier-loading test file (alphabetically,
// access.test.ts) has almost always already imported it — setting
// process.env.METRICS_TOKEN here would be too late to matter. The
// `metricsToken` option (app.ts's own comment) exists for exactly this.
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../app.ts';
import {
  recordRequest,
  recordTileCache,
  resetMetricsForTest,
} from '../metrics.ts';

const TOKEN = 'test-metrics-token';

describe('metrics: GET /metrics', () => {
  let server: Server;
  let base = '';

  beforeAll(async () => {
    server = createHttpServer({ metricsToken: TOKEN });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  test('404s with no token', async () => {
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(404);
  });

  test('404s with the wrong token', async () => {
    const res = await fetch(`${base}/metrics?token=${TOKEN}wrong`);
    expect(res.status).toBe(404);
  });

  test('200 text/plain with the right token, as a query param', async () => {
    const res = await fetch(`${base}/metrics?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  test('200 with the right token as a Bearer header', async () => {
    const res = await fetch(`${base}/metrics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test('body carries request counts, tile cache counters, worker queue depth and sheet room gauges', async () => {
    resetMetricsForTest();
    recordRequest('GET', '/boards/:id', 200, 12.3);
    recordRequest('GET', '/boards/:id', 404, 1.1);
    recordTileCache('resident');
    recordTileCache('resident');
    recordTileCache('miss');

    const res = await fetch(`${base}/metrics?token=${TOKEN}`);
    const body = await res.text();

    expect(body).toContain(
      'digsite_requests_total{method="GET",route="/boards/:id",status="200"} 1',
    );
    expect(body).toContain(
      'digsite_requests_total{method="GET",route="/boards/:id",status="404"} 1',
    );
    expect(body).toContain(
      'digsite_request_duration_ms_count{method="GET",route="/boards/:id"} 2',
    );
    expect(body).toContain('digsite_tile_cache_total{cache="resident"} 2');
    expect(body).toMatch(/^digsite_ladder_resident_bytes \d+$/m);
    expect(body).toMatch(/^digsite_ladder_evictions_total \d+$/m);
    expect(body).toMatch(/^digsite_coarse_resident_bytes \d+$/m);
    expect(body).toContain('digsite_tile_cache_total{cache="miss"} 1');
    expect(body).toContain('digsite_worker_queue_depth');
    expect(body).toContain('digsite_sheet_rooms');
    expect(body).toContain('digsite_sheet_peers');
  });

  test('an unmatched path is labelled (unmatched), never the raw path (cardinality guard)', async () => {
    resetMetricsForTest();
    const marker = `this-path-does-not-exist-${Date.now()}`;
    await fetch(`${base}/${marker}`);
    const res = await fetch(`${base}/metrics?token=${TOKEN}`);
    const body = await res.text();
    expect(body).toContain('route="(unmatched)"');
    expect(body).not.toContain(marker);
  });
});
