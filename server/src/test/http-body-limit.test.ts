import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { PassThrough } from 'node:stream';
import { RequestBodyTooLargeError, toWebRequest } from '../http.ts';
import { json } from '../http.ts';

type TestRequest = PassThrough &
  Pick<IncomingMessage, 'headers' | 'method' | 'url'>;

function request(headers: Record<string, string> = {}): TestRequest {
  const stream = new PassThrough() as TestRequest;
  stream.headers = headers;
  stream.method = 'POST';
  stream.url = '/upload';
  return stream;
}

test('rejects an oversized Content-Length before retaining the body and drains it', async () => {
  const req = request({ 'content-length': '9' });
  const webRequest = toWebRequest(req as unknown as IncomingMessage, 8);
  await expect(webRequest).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  const drained = new Promise<void>((resolve) => req.once('end', resolve));
  req.end('123456789');
  await drained;
  expect(req.readableEnded).toBe(true);
});

test('rejects an oversized chunked body as soon as it crosses the limit', async () => {
  const req = request({ 'transfer-encoding': 'chunked' });
  const webRequest = toWebRequest(req as unknown as IncomingMessage, 8);
  req.write('123456');
  req.write('789');
  await expect(webRequest).rejects.toBeInstanceOf(RequestBodyTooLargeError);
  const drained = new Promise<void>((resolve) => req.once('end', resolve));
  req.end('discarded');
  await drained;
  expect(req.readableEnded).toBe(true);
});

test('constructs the web request for a body within the configured bound', async () => {
  const req = request({ 'transfer-encoding': 'chunked' });
  const webRequest = toWebRequest(req as unknown as IncomingMessage, 8);
  req.end('12345678');
  const result = await webRequest;
  expect(await result.text()).toBe('12345678');
});

test('HTTP callers receive JSON 413 for oversized chunked input and 200 below the cap', async () => {
  const server = createServer(async (req, res) => {
    try {
      const webRequest = await toWebRequest(req as IncomingMessage, 8);
      json(res, 200, { body: await webRequest.text() });
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        json(res, 413, { error: 'request body exceeds 8 bytes' });
        return;
      }
      json(res, 500, { error: 'unexpected test error' });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no test port');

  const postChunked = (body: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        `http://127.0.0.1:${address.port}/upload`,
        {
          agent: false,
          method: 'POST',
          headers: { 'transfer-encoding': 'chunked' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      req.on('error', reject);
      req.write(body.slice(0, 5));
      req.end(body.slice(5));
    });

  try {
    const tooLarge = await postChunked('123456789');
    expect(tooLarge.status).toBe(413);
    expect(JSON.parse(tooLarge.body)).toEqual({
      error: 'request body exceeds 8 bytes',
    });

    const normal = await postChunked('hello!!');
    expect(normal.status).toBe(200);
    expect(JSON.parse(normal.body)).toEqual({ body: 'hello!!' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
