import { describe, expect, test } from 'bun:test';
// 0015_job_leases.sql: a worker killed mid-job used to leave the job
// `running` and its image `pending` forever. Each test strands a job the way
// a dead worker does — state running, lease in the past — and runs the
// worker once.
import { createCanvas } from '@napi-rs/canvas';
import { uploadOne } from '../boards/upload.ts';
import { pool } from '../db/pool.ts';
import { drain } from '../worker/index.ts';

async function makeBoard(name: string): Promise<string> {
  const { rows } = await pool.query(
    'INSERT INTO boards (org_id, name, open, created_by) VALUES ($1,$2,true,$3) RETURNING id',
    [`org-test-${Date.now()}`, name, 'test-user'],
  );
  return rows[0].id;
}

function square(hue: number): Buffer {
  const canvas = createCanvas(16, 16);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${hue}, 80%, 50%)`;
  ctx.fillRect(0, 0, 16, 16);
  return canvas.encodeSync('png');
}

/** An uploaded image whose ladder job a dead worker holds. */
async function stranded(
  attempts: number,
  lease: string,
): Promise<{ imageId: string; jobId: number }> {
  const boardId = await makeBoard(`lease-${Date.now()}-${attempts}`);
  const image = await uploadOne(
    boardId,
    'tester',
    'a.png',
    square(attempts * 90),
  );
  const { rows } = await pool.query(
    `UPDATE jobs SET state = 'running', attempts = $2,
       lease_until = now() + $3::interval
     WHERE kind = 'ladder' AND payload->>'imageId' = $1
     RETURNING id`,
    [image.id, attempts, lease],
  );
  return { imageId: image.id, jobId: rows[0].id };
}

async function imageStatus(id: string) {
  const { rows } = await pool.query(
    'SELECT status, error FROM images WHERE id = $1',
    [id],
  );
  return rows[0] as { status: string; error: string | null };
}

async function job(id: number) {
  const { rows } = await pool.query(
    'SELECT state, attempts FROM jobs WHERE id = $1',
    [id],
  );
  return rows[0] as { state: string; attempts: number } | undefined;
}

describe('worker leases', () => {
  test('a job whose worker died is taken again and finishes', async () => {
    const { imageId, jobId } = await stranded(0, '-1 second');
    await drain();
    expect(await job(jobId)).toBeUndefined();
    expect((await imageStatus(imageId)).status).toBe('ready');
  });

  test('a job that killed its worker on every attempt ends failed', async () => {
    const { imageId, jobId } = await stranded(3, '-1 second');
    await drain();
    expect(await job(jobId)).toEqual({ state: 'failed', attempts: 4 });
    const image = await imageStatus(imageId);
    expect(image.status).toBe('failed');
    expect(image.error).toContain('lease expired');
  });

  test('a job with a live lease is left to its worker', async () => {
    const { imageId, jobId } = await stranded(0, '1 minute');
    await drain();
    expect(await job(jobId)).toEqual({ state: 'running', attempts: 0 });
    expect((await imageStatus(imageId)).status).toBe('pending');
    await pool.query('DELETE FROM jobs WHERE id = $1', [jobId]);
  });
});
