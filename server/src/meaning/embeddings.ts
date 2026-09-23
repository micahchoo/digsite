// The embedding store: every read of stored CLIP vectors goes through here
// (CONTEXT.md "Embedding"). Before it, search and label suggestions parsed
// pgvector's text form and the arrangement read the binary form with its
// own decoder and its own memory fixes; each new reader would have picked
// one of the three.
//
// One wire format: pgvector's binary halfvec, a 16-bit dimension count, 16
// unused bits, then big-endian float16s, decoded through one table.
//
// A whole board's vectors are packed in one array, float32 while they fit
// ARRANGE_BUDGET_MB, int8 (x127) beyond it. Measured 2026-09-23: int8
// arranged 20,001 photos as well as float32 (best match within two rows
// 12.8% vs 14.8%, neighbour similarity 0.9513 vs 0.9514) at a quarter of
// the memory and 2.2x the time. Float16Array was 14x slower than either
// in Bun, so it is not a choice.
import { pool } from '../db/pool.ts';
import { env } from '../env.ts';
import type { Vectors } from './arrange.ts';
import { MODEL } from './model.ts';

export const DIMS = 512;
const PAGE = 20_000;

// float16 bits -> float32, decoded once for every bit pattern.
const HALF = (() => {
  const table = new Float32Array(65536);
  const view = new DataView(new ArrayBuffer(2));
  for (let bits = 0; bits < 65536; bits++) {
    view.setUint16(0, bits);
    table[bits] = view.getFloat16(0);
  }
  return table;
})();

/** Scratch for one decoded vector before it is normalised. */
const raw = new Float32Array(DIMS);

/** Decodes one stored vector into `out` at `offset`, as a UNIT vector,
 * times `scale` (127 for int8). Callers treat a dot product as a cosine
 * (the arrangement, the duplicate sweep) and int8 packing assumes every
 * component within ±1, so the store guarantees it rather than trusting
 * every writer: a synthetic board with vectors of norm 6.3 made the
 * sweep take half of all neighbour pairs for near-duplicates. */
function decodeInto(
  bin: Buffer,
  out: Float32Array | Int8Array,
  offset: number,
  scale: number,
): void {
  if (bin.readUInt16BE(0) !== DIMS) {
    throw new Error(`an embedding is ${bin.readUInt16BE(0)}-d, not ${DIMS}`);
  }
  let norm = 0;
  for (let k = 0; k < DIMS; k++) {
    const at = 4 + k * 2;
    const value = HALF[
      ((bin[at] as number) << 8) | (bin[at + 1] as number)
    ] as number;
    raw[k] = value;
    norm += value * value;
  }
  const factor = norm > 0 ? scale / Math.sqrt(norm) : 0;
  for (let k = 0; k < DIMS; k++) {
    const value = (raw[k] as number) * factor;
    out[offset + k] = scale === 1 ? value : Math.round(value);
  }
}

/** One image's stored vector, or null when it has none. */
export async function vectorOf(imageId: string): Promise<Float32Array | null> {
  const { rows } = await pool.query<{ bin: Buffer }>(
    `SELECT halfvec_send(embedding) AS bin FROM image_embeddings
     WHERE image_id = $1 AND model = $2`,
    [imageId, MODEL],
  );
  const bin = rows[0]?.bin;
  if (!bin) return null;
  const out = new Float32Array(DIMS);
  decodeInto(bin, out, 0, 1);
  return out;
}

/** Every stored vector of a board, in slot order, packed. `budgetBytes`
 * decides float32 or int8; an image embedded after the count is left for
 * the next reader. */
export async function boardVectors(
  boardId: string,
  budgetBytes = env.ARRANGE_BUDGET_MB * 1024 * 1024,
): Promise<{ ids: string[]; vectors: Vectors }> {
  const { rows: counted } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM image_embeddings WHERE board_id = $1 AND model = $2',
    [boardId, MODEL],
  );
  const capacity = counted[0]?.n ?? 0;
  const compact = capacity * DIMS * 4 > budgetBytes;
  const data = compact
    ? new Int8Array(capacity * DIMS)
    : new Float32Array(capacity * DIMS);
  const scale = compact ? 127 : 1;
  const ids: string[] = [];
  let after = -1;
  while (ids.length < capacity) {
    const { rows } = await pool.query<{
      image_id: string;
      slot: number;
      bin: Buffer;
    }>(
      `SELECT image_id, slot, halfvec_send(embedding) AS bin
       FROM image_embeddings
       WHERE board_id = $1 AND model = $2 AND slot > $3
       ORDER BY slot LIMIT $4`,
      [boardId, MODEL, after, Math.min(PAGE, capacity - ids.length)],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      decodeInto(row.bin, data, ids.length * DIMS, scale);
      ids.push(row.image_id);
    }
    after = rows[rows.length - 1]?.slot as number;
    // Each page arrives as hex text and becomes Buffers, memory outside
    // the JS heap that the collector does not see coming. Measured at a
    // million images: 6.4 GB peak with no collection or a minor one per
    // page, 2.4 GB with a full one, and the load no slower (4.6 s).
    Bun.gc(true);
  }
  return {
    ids,
    vectors: {
      data: data.subarray(0, ids.length * DIMS),
      count: ids.length,
      dims: DIMS,
    },
  };
}
