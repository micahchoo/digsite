// The `s3` adapter: any S3-compatible endpoint (minio in dev, a real bucket
// in production), path-style so a self-hosted endpoint without wildcard DNS
// still works (`forcePathStyle: true` — virtual-hosted-style needs
// `<bucket>.<endpoint>` to resolve, which minio's default setup doesn't
// give you). Keys are used exactly as fs.ts uses them as relative paths —
// no leading slash, no bucket prefix (the bucket is the client's own
// config, not part of the key).
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../env.ts';
import type { Storage } from './index.ts';

async function toBytes(body: unknown): Promise<Uint8Array> {
  // The SDK's GetObjectCommand body is a web ReadableStream under Bun/node's
  // fetch-based http handler; `transformToByteArray` is the documented,
  // runtime-agnostic way to drain it (works for the Node Readable variant
  // too, via @smithy/util-stream).
  const b = body as { transformToByteArray: () => Promise<Uint8Array> };
  return b.transformToByteArray();
}

export class S3Storage implements Storage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = requiredEnv('S3_BUCKET');
    this.client = new S3Client({
      endpoint: requiredEnv('S3_ENDPOINT'),
      region: env.S3_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: requiredEnv('S3_ACCESS_KEY'),
        secretAccessKey: requiredEnv('S3_SECRET_KEY'),
      },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!res.Body) return null;
      return await toBytes(res.Body);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    // S3's DeleteObject is already "succeeds whether or not the key
    // exists" — no existence check needed to match fs.ts's force-delete
    // semantics.
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** A short-lived, GET-only URL for `key` — s3.ts's own capability, not
   * part of the Storage interface (see storage/index.ts#presignedGetUrl,
   * the only caller: fs has no equivalent, and the interface stays exactly
   * the four methods every adapter shares). */
  async presign(key: string, expiresInSeconds: number): Promise<string> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

function requiredEnv(
  name: 'S3_ENDPOINT' | 'S3_BUCKET' | 'S3_ACCESS_KEY' | 'S3_SECRET_KEY',
): string {
  const v = env[name];
  if (!v) throw new Error(`STORAGE=s3 requires ${name}`);
  return v;
}
