// Image intake (CONTEXT.md "Image intake"): every rule a picture passes
// before it becomes an image on a board, whichever way it came in — the
// multipart route, a finished tus upload, a folder import. Before this
// module each of the three wrote its own recipe, and they disagreed: the
// multipart route stored the client's content type, and only the folder
// import turned camera files into JPEGs or skipped a picture already on
// the board.
//
// Two steps, because the multipart route refuses a whole batch if one file
// is bad, so it must examine every file before it stores any:
//
//   examine  — the file's own faults: its properties must be a property
//              map; a phone or camera file becomes a JPEG (camera.ts); the
//              bytes must be a known image type inside the size and pixel
//              budgets (validate.ts); optionally, bytes already on the
//              board are refused. A refusal carries an HTTP status and a
//              reason a person can read.
//   store    — the board's side: room on the volume, the original stored,
//              the row, the ladder job (upload.ts#uploadOne). Its failures
//              are the server's (a full disk, the database) and are thrown,
//              never turned into a refusal.
//   storeAll — store for a batch that stops at the group's quota and says
//              which files landed before it (the multipart route, a copy).
//
// An extracted region comes in here too, as a picture already stored
// (`asStored`): it is our own PNG, never a camera file, whatever its name.
import { createHash } from 'node:crypto';
import { pool } from '../db/pool.ts';
import { QuotaExceeded, quotaRefusal } from '../storage/quota.ts';
import { fromCamera, isCameraFile } from './camera.ts';
import { isProperties } from './properties.ts';
import { type Source, type UploadedImage, uploadOne } from './upload.ts';
import { validateUpload } from './validate.ts';

export type Offered = {
  name: string;
  bytes: Uint8Array;
  /** Anything the caller received; examine refuses what is not a
   * property map. */
  properties?: unknown;
  /** An image's original already (a copy from another board): the bytes
   * are never converted again, and its kept camera source, if any, comes
   * with it. */
  asStored?: { source?: Source };
};

export type Examined = {
  ok: true;
  name: string;
  bytes: Uint8Array;
  properties: Record<string, unknown>;
  /** From the bytes, never from the client. */
  contentType: string;
  /** The phone or camera file, kept beside the JPEG made from it. */
  source?: Source;
};

export type Refused = { ok: false; status: number; reason: string };

/** Everything about one offered file that is the file's own business. */
export async function examine(
  boardId: string,
  offered: Offered,
  options: { skipDuplicates?: boolean } = {},
): Promise<Examined | Refused> {
  if (offered.properties !== undefined && !isProperties(offered.properties)) {
    return {
      ok: false,
      status: 400,
      reason: 'properties must be a valid property map',
    };
  }
  const properties: Record<string, unknown> = {
    ...((offered.properties as Record<string, unknown> | undefined) ?? {}),
  };
  let bytes = offered.bytes;
  let source: Source | undefined = offered.asStored?.source;
  if (!offered.asStored && isCameraFile(offered.name)) {
    const converted = await fromCamera(offered.name, bytes);
    if (!converted.ok)
      return { ok: false, status: 415, reason: converted.reason };
    source = { bytes: offered.bytes, format: converted.format };
    bytes = converted.bytes;
    properties.format = converted.format;
  }
  const valid = validateUpload(bytes);
  if (!valid.ok)
    return { ok: false, status: valid.status, reason: valid.reason };
  if (options.skipDuplicates) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const { rows } = await pool.query(
      'SELECT name FROM images WHERE board_id = $1 AND sha256 = $2 LIMIT 1',
      [boardId, sha256],
    );
    if (rows[0]) {
      return {
        ok: false,
        status: 409,
        reason: `already on this board as ${rows[0].name}`,
      };
    }
  }
  return {
    ok: true,
    name: offered.name,
    bytes,
    properties,
    contentType: `image/${valid.type}`,
    ...(source ? { source } : {}),
  };
}

/** Makes an examined file an image on the board. Throws StorageFull, or
 * whatever the database throws: those are never the file's fault. */
export function store(
  boardId: string,
  userId: string,
  examined: Examined,
): Promise<UploadedImage> {
  return uploadOne(
    boardId,
    userId,
    examined.name,
    examined.bytes,
    examined.properties,
    examined.contentType,
    examined.source,
  );
}

export type StoredAll = {
  images: UploadedImage[];
  /** The group's storage filled before every file was stored: the 413
   * body, naming in order the files that landed before it. */
  full: (ReturnType<typeof quotaRefusal> & { accepted: Accepted[] }) | null;
};
type Accepted = { name: string; id: string };

/** Stores each file in order, stopping at the first the group's quota
 * refuses. Anything else thrown is the server's, and is thrown. */
export async function storeAll(
  boardId: string,
  userId: string,
  files: readonly Examined[],
): Promise<StoredAll> {
  const images: UploadedImage[] = [];
  for (const file of files) {
    try {
      images.push(await store(boardId, userId, file));
    } catch (error) {
      if (!(error instanceof QuotaExceeded)) throw error;
      const accepted = images.map((image, i) => ({
        name: files[i]?.name ?? '',
        id: image.id,
      }));
      return { images, full: { ...quotaRefusal(error), accepted } };
    }
  }
  return { images, full: null };
}
