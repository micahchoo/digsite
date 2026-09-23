// Real-server acceptance for the board tray. The stub smoke covers gestures;
// this walk checks that the browser, persistence and sheet layout agree.
import type { GetSheetResponse } from '@digsite/shared';
import { createCanvas } from '@napi-rs/canvas';
import { chromium } from 'playwright';
import { SERVER, WEB, signIn } from './session.ts';

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function eventually(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(message);
}

interface BoardWindow extends Window {
  __digsiteBoard?: { selectImages(ids: string[]): void };
}

async function main() {
  const owner = await signIn('owner@example.test', 'password1234');
  const groups = await owner.get<{ id: string; name: string }[]>('/groups');
  const group = groups.json.find((g) => g.name === 'Lab');
  assert(group, 'seeded Lab group missing');
  const created = await owner.post<{ id: string }>(
    `/groups/${group.id}/boards`,
    { name: `Selection acceptance ${Date.now()}`, open: true },
  );
  assert(created.status === 200, 'board creation failed');
  const boardId = created.json.id;
  const browser = await chromium.launch();
  try {
    const canvas = createCanvas(32, 32);
    canvas.getContext('2d').fillRect(0, 0, 32, 32);
    const form = new FormData();
    for (const name of ['zebra.png', 'apple.png', 'middle.png']) {
      form.append(
        'files',
        new Blob([new Uint8Array(canvas.toBuffer('image/png'))], {
          type: 'image/png',
        }),
        name,
      );
    }
    const upload = await owner.postForm<{ id: string }[]>(
      `/boards/${boardId}/images`,
      form,
    );
    assert(upload.status === 202 && upload.json.length === 3, 'upload failed');
    const ids = upload.json.map((image) => image.id);
    const context = await browser.newContext({
      viewport: { width: 1600, height: 1000 },
    });
    await context.addCookies([
      {
        name: 'better-auth.session_token',
        value: owner.cookie.split('=').slice(1).join('='),
        url: SERVER,
      },
    ]);
    const page = await context.newPage();
    const selected = ids.slice(0, 2);
    const persisted = async () => {
      const result = await owner.get<{ imageIds: string[] }>(
        `/boards/${boardId}/selection`,
      );
      assert(result.status === 200, 'selection GET failed');
      return result.json.imageIds;
    };
    const equals = (a: string[], b: string[]) =>
      JSON.stringify(a) === JSON.stringify(b);
    await page.goto(`${WEB}/b/${boardId}`);
    await page.waitForFunction(() =>
      Boolean((window as BoardWindow).__digsiteBoard),
    );
    await page.getByTestId('board-find-toggle').click();
    await page.getByTestId('board-find-query').fill('apple');
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="board-find-count"]')
          ?.textContent?.trim() === '1 match',
    );
    await page.getByTestId('board-find-select-matches').click();
    await eventually(
      async () => equals(await persisted(), [ids[1] ?? '']),
      'find did not select the matching real image',
    );
    await page.getByTestId('board-find-query').fill('');
    await page.getByTestId('board-find-toggle').click();
    console.log(
      'PASS: find selects the matching image through the real server',
    );
    await page.evaluate(
      (imageIds) =>
        (window as BoardWindow).__digsiteBoard?.selectImages(imageIds),
      selected,
    );
    await eventually(
      async () => equals(await persisted(), selected),
      'selection was not saved',
    );
    await page.getByTestId('sort-key').selectOption(JSON.stringify('name'));
    await page.getByTestId('sort-dir').click();
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="selection-item"]').length ===
        2,
    );
    assert(
      equals(await persisted(), selected),
      'sort or reload changed image IDs',
    );
    console.log(
      'PASS: real server restores selected image IDs after sort and reload',
    );

    const thumbs = page.getByTestId('selection-item');
    const before = await thumbs.first().getAttribute('title');
    await thumbs.first().dragTo(thumbs.nth(1));
    const reordered = [...selected].reverse();
    await eventually(
      async () => equals(await persisted(), reordered),
      'tray order was not saved',
    );
    assert(
      (await thumbs.first().getAttribute('title')) !== before,
      'tray did not reorder',
    );
    await page.getByTestId('board-tray-start-sheet').click();
    await page.getByTestId('board-tray-sheet-name').fill('Tray order');
    await page.getByTestId('board-tray-sheet-create').click();
    await page.waitForURL(/\/s\//);
    const sheetId = new URL(page.url()).pathname.split('/').pop();
    const sheet = await owner.get<GetSheetResponse>(`/sheets/${sheetId}`);
    assert(sheet.status === 200, 'created sheet missing');
    const scene = await owner.get<{
      elements: {
        x: number;
        y: number;
        customData?: { kind: string; imageId: string };
      }[];
    }>(`/sheets/${sheetId}/elements`);
    assert(scene.status === 200, 'created scene missing');
    const layoutIds = scene.json.elements
      .filter((element) => element.customData?.kind === 'image')
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((element) => element.customData?.imageId ?? '');
    assert(equals(layoutIds, reordered), 'sheet layout differs from tray');
    console.log('PASS: real sheet follows the reordered tray');

    await page.getByTestId('show-on-board').click();
    await page.waitForURL(/\/b\//);
    await page.waitForFunction(
      () =>
        !new URL(window.location.href).searchParams.has('showSheet') &&
        Boolean((window as BoardWindow).__digsiteBoard),
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="selection-item"]').length ===
        2,
    );
    await page.evaluate(
      (imageIds) =>
        (window as BoardWindow).__digsiteBoard?.selectImages(imageIds),
      ids,
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll('[data-testid="selection-item"]').length ===
        3,
    );
    await page.getByTestId('board-tray-add-to-sheet').click();
    await page.getByTestId(`board-tray-add-to-sheet-${sheetId}`).click();
    await eventually(async () => {
      const result = await owner.get<GetSheetResponse>(`/sheets/${sheetId}`);
      return result.status === 200 && result.json.images.length === 3;
    }, 'add-to-sheet failed or duplicated existing images');
    console.log('PASS: show-on-board and add-to-sheet work without duplicates');
  } finally {
    await browser.close();
    const removed = await owner.del(`/boards/${boardId}`);
    assert(
      removed.status === 200 || removed.status === 204,
      'acceptance board cleanup failed',
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
