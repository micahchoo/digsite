// Real browser + server acceptance: multipart and resumable uploads both
// retain their accepted IDs, finish processing, and report ready in the UI.
import { createCanvas } from '@napi-rs/canvas';
import { chromium } from 'playwright';
import { SERVER, WEB, signIn } from './session.ts';
const SMALL_IMAGES = 133;
const TOTAL_IMAGES = SMALL_IMAGES + 1;

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function main() {
  const owner = await signIn('owner@example.test', 'password1234');
  const groups = await owner.get<{ id: string; name: string }[]>('/groups');
  const group = groups.json.find((entry) => entry.name === 'Lab');
  assert(group, 'seeded Lab missing');
  const created = await owner.post<{ id: string }>(
    `/groups/${group.id}/boards`,
    {
      name: 'Upload queue acceptance',
      open: true,
    },
  );
  assert(created.status === 200, 'board creation failed');
  const boardId = created.json.id;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await context.addCookies([
      {
        name: 'better-auth.session_token',
        value: owner.cookie.split('=').slice(1).join('='),
        url: SERVER,
      },
    ]);
    const page = await context.newPage();
    let rateLimited = 0;
    page.on('response', (response) => {
      if (response.status() === 429 && response.url().includes('/images'))
        rateLimited++;
    });
    await page.goto(`${WEB}/b/${boardId}`);
    await page.getByTestId('upload-input').waitFor({ state: 'attached' });
    const canvas = createCanvas(8, 8);
    canvas.getContext('2d').fillRect(0, 0, 8, 8);
    const png = canvas.toBuffer('image/png');
    // Trailing bytes keep a valid PNG while exercising the >8MB tus branch.
    const large = Buffer.concat([png, Buffer.alloc(8 * 1024 * 1024 + 1)]);
    const files = Array.from({ length: SMALL_IMAGES }, (_, index) => ({
      name: `queue-small-${index}.png`,
      mimeType: 'image/png',
      buffer: png,
    }));
    files.push({
      name: 'queue-large.png',
      mimeType: 'image/png',
      buffer: large,
    });
    const resumable = page.waitForResponse(
      async (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes('/uploads/') &&
        response.status() === 204 &&
        Number(await response.headerValue('Upload-Offset')) === large.length,
    );
    await page.getByTestId('upload-input').setInputFiles(files);
    await page.getByTestId('upload-counts').waitFor();
    const completed = await resumable;
    assert(
      await completed.headerValue('Upload-Image-Id'),
      'tus completion did not identify its accepted image',
    );
    await page.waitForFunction(
      (total) =>
        document
          .querySelector('[data-testid="upload-counts"]')
          ?.textContent?.includes(`${total} ready`),
      TOTAL_IMAGES,
      { timeout: 60_000 },
    );
    const result = await owner.get<{
      images: { id: string; name: string; status: string }[];
    }>(`/boards/${boardId}/images?sort=uploaded_at.desc&count=500`);
    assert(
      rateLimited === 0,
      'ordinary bulk upload hit an artificial rate pause',
    );
    assert(
      result.status === 200 && result.json.images.length === TOTAL_IMAGES,
      'queue lost or duplicated uploaded images',
    );
    assert(
      result.json.images.every((image) => image.status === 'ready'),
      'some accepted images never became ready',
    );
    assert(
      new Set(result.json.images.map((image) => image.name)).size ===
        TOTAL_IMAGES,
      'upload filenames were duplicated',
    );
    console.log(
      `PASS: ${SMALL_IMAGES} multipart images and one resumable image reach ready without rate pauses`,
    );
  } finally {
    await browser.close();
    const removed = await owner.del(`/boards/${boardId}`);
    assert(
      removed.status === 200 || removed.status === 204,
      'upload acceptance board cleanup failed',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
