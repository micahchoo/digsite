// docs/ux/audit.md #2: the Excalidraw sheet canvas rendered every image as
// a generic grey placeholder while the native adapter rendered the same
// data correctly. Diagnosed cause: `ExcalidrawCanvas.tsx`'s own
// `apiRef.current` (Excalidraw's imperative API) is not guaranteed ready by
// the time this component's effects first run — its own initialisation can
// outlast ours under load. The `files` effect that registers each image's
// bitmap (`api.addFiles`) checked `apiRef.current` and silently gave up,
// with no retry, if it was still null; since `files` only changes once (one
// `setFiles` after every preview finishes loading — `sheet/images.ts`), a
// single missed run meant that image's `fileId` was never registered and
// Excalidraw drew its own placeholder forever. Fixed by queueing the flush
// and replaying it once the API exists (`ExcalidrawCanvas.tsx`'s
// `readyQueue`).
//
// This script proves the fix at the pixel level, the same way a human
// would notice the bug: decode an actual canvas pixel inside a known
// image's rect, on BOTH adapters, and check it against the colour the stub
// painted that image with (`web/stub/server.ts#paintImage`:
// `hsl((slot * 137.508) % 360, 65%, 55%)`) — a grey/blank placeholder does
// not match, on either adapter, regardless of how it's drawn.
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { type Page, chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5180';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

// Standard HSL -> RGB (0-255), matching CSS `hsl()` semantics — used to
// compute the exact colour web/stub/server.ts#paintImage filled image
// `img-0`'s canvas with, at s=65%/l=55%, so this script never has to
// hard-code a "known good" pixel captured from a prior run.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let [r, g, b] = [0, 0, 0];
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

async function pixelAt(
  page: Page,
  x: number,
  y: number,
): Promise<[number, number, number, number]> {
  const buf = await page.screenshot({
    clip: { x: x - 1, y: y - 1, width: 3, height: 3 },
  });
  const img = await loadImage(buf);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(1, 1, 1, 1).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
}

function closeColor(
  got: [number, number, number, number],
  expected: [number, number, number],
  tolerance: number,
): boolean {
  return (
    Math.abs(got[0] - expected[0]) <= tolerance &&
    Math.abs(got[1] - expected[1]) <= tolerance &&
    Math.abs(got[2] - expected[2]) <= tolerance
  );
}

async function checkAdapter(page: Page, adapter: 'excalidraw' | 'native') {
  await page.goto(`${WEB}/s/s1?canvas=${adapter}`);
  await page.waitForFunction(() => typeof window.__digsite !== 'undefined');
  await page.waitForFunction(
    () => window.__digsite.getElements().length > 0,
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(2000); // let every image file decode and paint
  await page.evaluate(() => window.__digsite.zoomToFit());
  await page.waitForTimeout(300);

  const rect = await page.evaluate(() =>
    window.__digsite.getElements().find(
      // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
      (e: any) =>
        e.customData?.kind === 'image' && e.customData.imageId === 'img-0',
    ),
  );
  assert(rect, `[${adapter}] no image element for img-0`);
  const r = rect as { x: number; y: number; width: number; height: number };

  const box = await page.locator('.digsite-canvas').first().boundingBox();
  assert(box, `[${adapter}] no .digsite-canvas container on screen`);
  const vp = await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: crosses the browser boundary
    const s: any = window.__digsiteSheetDebug?.getAppState();
    return { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value };
  });

  // A quarter-point of the image rect, away from the centre digit label
  // paintImage draws — a point squarely inside the flat fill colour.
  const sx = r.x + r.width * 0.25;
  const sy = r.y + r.height * 0.25;
  const cx = box.x + (sx + vp.scrollX) * vp.zoom;
  const cy = box.y + (sy + vp.scrollY) * vp.zoom;

  const pixel = await pixelAt(page, cx, cy);
  const expected = hslToRgb((0 * 137.508) % 360, 0.65, 0.55); // img-0 -> slot 0
  assert(
    closeColor(pixel, expected, 40),
    `[${adapter}] pixel at img-0's quarter-point was rgb(${pixel[0]},${pixel[1]},${pixel[2]}), expected close to rgb(${expected[0]},${expected[1]},${expected[2]}) — looks like a placeholder, not the real image`,
  );
  console.log(
    `PASS [${adapter}]: img-0 decodes to rgb(${pixel[0]},${pixel[1]},${pixel[2]}), matching the painted colour rgb(${expected[0]},${expected[1]},${expected[2]})`,
  );
}

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
  });

  await page.goto(WEB);
  await page.getByTestId('email').fill('owner@example.test');
  await page.getByTestId('password').fill('password1');
  await page.getByTestId('submit').click();
  await page.waitForURL(/\/groups$/);
  console.log('signed in');

  await checkAdapter(page, 'native');
  await checkAdapter(page, 'excalidraw');

  await browser.close();
  console.log('smoke-image-render: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
