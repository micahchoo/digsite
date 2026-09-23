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
interface SheetWindow extends Window {
  __digsite?: {
    getElements(): { customData?: { kind?: string; imageId?: string } }[];
  };
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
  let bandBoardId: string | null = null;
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

    const bandBoard = await owner.post<{ id: string }>(
      `/groups/${group.id}/boards`,
      { name: `Band selection ${Date.now()}`, open: true },
    );
    assert(bandBoard.status === 200, 'band fixture board creation failed');
    bandBoardId = bandBoard.json.id;
    const bandForm = new FormData();
    for (let index = 0; index < 20; index++) {
      bandForm.append(
        'files',
        new Blob([new Uint8Array(canvas.toBuffer('image/png'))], {
          type: 'image/png',
        }),
        `image-${String(index).padStart(2, '0')}.png`,
      );
    }
    const bandUpload = await owner.postForm<{ id: string }[]>(
      `/boards/${bandBoardId}/images`,
      bandForm,
    );
    assert(
      bandUpload.status === 202 && bandUpload.json.length === 20,
      'band fixture upload failed',
    );
    const linear = await owner.post<{ imageIds: string[] }>(
      `/boards/${bandBoardId}/selection/range`,
      { sort: 'name.asc', fromRank: 0, toRank: 18 },
    );
    const band = await owner.post<{ imageIds: string[] }>(
      `/boards/${bandBoardId}/selection/range`,
      { sort: 'name.asc', fromRank: 0, toRank: 18, mode: 'band' },
    );
    const reverseBand = await owner.post<{ imageIds: string[] }>(
      `/boards/${bandBoardId}/selection/range`,
      { sort: 'name.asc', fromRank: 18, toRank: 0, mode: 'band' },
    );
    const invalidMode = await owner.post(
      `/boards/${bandBoardId}/selection/range`,
      { sort: 'name.asc', fromRank: 0, toRank: 18, mode: 'columns' },
    );
    assert(
      linear.status === 200 && linear.json.imageIds.length === 19,
      `linear range selected ${linear.json.imageIds.length} instead of 19`,
    );
    assert(
      band.status === 200 && band.json.imageIds.length === 6,
      `rectangle band selected ${band.json.imageIds.length} instead of 6`,
    );
    assert(
      reverseBand.status === 200 &&
        JSON.stringify(reverseBand.json.imageIds) ===
          JSON.stringify(band.json.imageIds),
      'reverse rectangle band changed its selected cells',
    );
    assert(invalidMode.status === 400, 'unknown selection mode was accepted');
    console.log(
      'PASS: real range route keeps linear ranges and selects only band rectangles',
    );

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

    const peer = await context.newPage();
    await peer.goto(`${WEB}/s/${sheetId}`);
    await peer.waitForFunction(
      () => (window as SheetWindow).__digsite?.getElements().length === 2,
    );
    const newImageId = ids.find((id) => !selected.includes(id));
    assert(newImageId, 'missing third image fixture');
    const assetLoaded = peer.waitForResponse(
      (response) =>
        response.url().endsWith(`/images/${newImageId}/preview`) &&
        response.status() === 200,
    );

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
    await assetLoaded;
    await peer.waitForFunction(
      (imageId) =>
        (window as SheetWindow).__digsite
          ?.getElements()
          .some((element) => element.customData?.imageId === imageId),
      newImageId,
    );
    await peer.close();
    console.log(
      'PASS: an already-open sheet receives the added image and loads its preview',
    );

    await page.getByTestId('thread-browser-open').click();
    await page.getByTestId('thread-search').fill('Tray order');
    const thread = page.locator(
      `[data-testid="thread-row"][data-sheet-id="${sheetId}"]`,
    );
    await thread.waitFor();
    await thread.getByTestId('thread-archive').click();
    await eventually(async () => {
      const result = await owner.get<{ id: string }[]>(
        `/boards/${boardId}/sheets`,
      );
      return (
        result.status === 200 && !result.json.some((row) => row.id === sheetId)
      );
    }, 'archived sheet remained in active listing');
    await page.getByTestId('thread-status').selectOption('archived');
    await thread.waitFor();
    const retained = await owner.get<GetSheetResponse>(`/sheets/${sheetId}`);
    assert(
      retained.status === 200 && retained.json.images.length === 3,
      'archive removed sheet content',
    );
    await thread.getByTestId('thread-archive').click();
    await page.getByTestId('thread-status').selectOption('active');
    await thread.waitFor();
    await thread.getByRole('link', { name: 'Tray order', exact: true }).click();
    await page.waitForURL(new RegExp(`/s/${sheetId}$`));
    await eventually(async () => {
      const result = await owner.get<{ id: string; unread: boolean }[]>(
        `/groups/${group.id}/sheets`,
      );
      return (
        result.status === 200 &&
        result.json.some((row) => row.id === sheetId && !row.unread)
      );
    }, 'opening sheet did not persist its read state');
    console.log(
      'PASS: real thread browser archives, retains content, reopens and records read state',
    );
  } finally {
    await browser.close();
    if (bandBoardId) {
      const bandRemoved = await owner.del(`/boards/${bandBoardId}`);
      assert(
        bandRemoved.status === 200 || bandRemoved.status === 204,
        'band fixture board cleanup failed',
      );
    }
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
