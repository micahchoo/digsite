// Run only against an already migrated disposable database. See
// docs/measurements/bulk-upload-throughput.md for the measured workload.
import { createCanvas } from '@napi-rs/canvas';
import { uploadOne } from '../src/boards/upload.ts';
import { pool } from '../src/db/pool.ts';
import { startWorker, stopWorker } from '../src/worker/index.ts';
if (
  !new URL(process.env.DATABASE_URL ?? '').pathname.startsWith(
    '/digsite_ingest_',
  )
)
  throw new Error('Use a disposable digsite_ingest_* database');
const count = Number(process.env.BENCH_IMAGES ?? 120);
const c = createCanvas(640, 480);
const ctx = c.getContext('2d');
const { rows } = await pool.query(
  "INSERT INTO boards (org_id,name,open,created_by) VALUES ('bench-org','ingest benchmark',true,'bench') RETURNING id",
);
const id = rows[0].id;
let peak = process.memoryUsage().rss;
const started = performance.now();
for (let n = 0; n < count; n++) {
  ctx.fillStyle = `hsl(${n % 360},65%,50%)`;
  ctx.fillRect(0, 0, 640, 480);
  ctx.fillStyle = '#fff';
  ctx.fillText(String(n), 10, 30);
  await uploadOne(id, 'bench', `${n}.png`, c.encodeSync('png'));
}
const accepted = performance.now();
startWorker();
let ready = 0;
while (ready < count && performance.now() - accepted < 120000) {
  await Bun.sleep(25);
  const r = await pool.query(
    "SELECT count(*)::int n FROM images WHERE board_id=$1 AND status='ready'",
    [id],
  );
  ready = r.rows[0].n;
  peak = Math.max(peak, process.memoryUsage().rss);
}
stopWorker();
console.log(
  JSON.stringify({
    count,
    ready,
    acceptMs: Math.round(accepted - started),
    processMs: Math.round(performance.now() - accepted),
    peakRssMb: Math.round(peak / 1048576),
  }),
);
await pool.end();
process.exit(ready === count ? 0 : 1);
