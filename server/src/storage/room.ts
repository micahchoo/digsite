// A full disk is the failure a small self-hosted group actually meets:
// Postgres and the worker then fail in ways that are hard to recover from.
// So uploads stop first, while there is still room to run. Checked on the
// one ingest path, boards/upload.ts#uploadOne, which browser uploads,
// resumable uploads and folder imports all go through.
//
// Only for STORAGE=fs; an S3 bucket's room is its provider's concern.
import { statfs } from 'node:fs/promises';
import { env } from '../env.ts';

export class StorageFull extends Error {
  constructor(freeBytes: number) {
    super(
      `storage is nearly full: ${Math.round(freeBytes / 1e9)} GB free, uploads stop below ${env.UPLOAD_MIN_FREE_GB} GB`,
    );
  }
}

// statfs per file of a 20,000-file import would be 20,000 syscalls for a
// number that moves slowly; one reading per second is plenty.
const MAX_AGE_MS = 1_000;
let reading: { at: number; free: number } | null = null;

/** Free bytes from statfs's block counts. They must arrive as bigints:
 * Bun returns the plain-number form as a SIGNED 32-bit value, so a 24 TB
 * volume's 3.6 billion free blocks read as -649,758,170, "-2,661 GB free",
 * and every upload was refused (found 2026-09-23 on /mnt/Ghar). */
export function freeFrom(stats: { bavail: bigint; bsize: bigint }): number {
  return Number(stats.bavail * stats.bsize);
}

async function freeBytes(): Promise<number> {
  const now = Date.now();
  if (!reading || now - reading.at > MAX_AGE_MS) {
    const stats = await statfs(env.DATA_DIR, { bigint: true });
    reading = { at: now, free: freeFrom(stats) };
  }
  return reading.free;
}

/** Throws StorageFull if writing `bytes` would leave less than
 * UPLOAD_MIN_FREE_GB free on the data volume. */
export async function ensureRoomFor(bytes: number): Promise<void> {
  if (env.STORAGE !== 'fs' || env.UPLOAD_MIN_FREE_GB <= 0) return;
  const free = await freeBytes();
  if (free - bytes < env.UPLOAD_MIN_FREE_GB * 1e9) throw new StorageFull(free);
}

/** Test-only: forget the cached reading. */
export function resetRoomForTest(): void {
  reading = null;
}
