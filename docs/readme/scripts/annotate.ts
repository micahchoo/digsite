// Draws study.ts onto the board load.ts made: one sheet per question, its
// regions and connections with their properties, confidence and note. It
// drives the sheet page's own tools (window.__digsite), so every claim
// passes through the room, is stamped by the signed-in person and is
// projected into rows like one drawn by hand. Each run adds six new sheets.
import type { PropertyValue } from '@digsite/shared';
import { chromium } from '../../../e2e/node_modules/playwright/index.mjs';
import { signIn } from '../../../e2e/src/session.ts';
import { BOARD, EMAIL, PASSWORD, WEB, sheetReady } from './lib.ts';
import { STUDY, type Sheet } from './study.ts';

type Fraction = { fx: number; fy: number; fw: number; fh: number };
type Tools = {
  getElements(): {
    id: string;
    customData?: { kind?: string; imageId?: string };
  }[];
  drawRegion(imageId: string, f: Fraction, label: string): string | null;
  connect(
    from: string,
    to: string,
    relation: string,
    dir: string,
  ): string | null;
  setProperty(id: string, key: string, value: PropertyValue): void;
  syncStatus(): { lastEmitAt: number | null };
  zoomToFit(): void;
};
type ToolWindow = { __digsite: Tools };

const s = await signIn(EMAIL, PASSWORD);

// The board's pictures by the AIC artwork id load.ts kept.
const byAic = new Map<number, string>();
for (let from = 0; ; from += 500) {
  const page = await s.get<{
    images: { id: string; properties: Record<string, unknown> }[];
  }>(`/boards/${BOARD}/images?from=${from}&count=500`);
  for (const img of page.json.images)
    if (typeof img.properties.aic === 'number')
      byAic.set(img.properties.aic, img.id);
  if (page.json.images.length < 500) break;
}
const imageOf = (aic: number) => {
  const id = byAic.get(aic);
  if (!id)
    throw new Error(
      `no picture with aic ${aic} on the board: was it made by load.ts from a fetch that found it?`,
    );
  return id;
};

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
await context.addCookies([
  {
    name: 'better-auth.session_token',
    value: s.cookie.split('=').slice(1).join('='),
    url: process.env.SERVER_ORIGIN ?? 'http://localhost:8800',
  },
]);
const page = await context.newPage();

for (const sheet of STUDY) {
  const ids = Object.fromEntries(sheet.pictures.map((a) => [a, imageOf(a)]));
  const made = await s.post<{ id: string }>(`/boards/${BOARD}/sheets`, {
    name: sheet.name,
    imageIds: Object.values(ids),
  });
  if (made.status !== 200) throw new Error(JSON.stringify(made));
  await page.goto(`${WEB}/s/${made.json.id}`);
  await sheetReady(page);
  await page.waitForTimeout(1500);

  const drawn = await page.evaluate(
    ({ sheet, ids }: { sheet: Sheet; ids: Record<number, string> }) => {
      const t = (window as unknown as ToolWindow).__digsite;
      const imageEl = new Map<string, string>();
      for (const e of t.getElements())
        if (e.customData?.kind === 'image' && e.customData.imageId)
          imageEl.set(e.customData.imageId, e.id);
      const region = new Map<string, string>();
      const failed: string[] = [];
      for (const r of sheet.regions) {
        const [fx, fy, fw, fh] = r.f;
        const imageId = ids[r.aic];
        const id =
          imageId && t.drawRegion(imageId, { fx, fy, fw, fh }, r.label);
        if (!id) {
          failed.push(`region ${r.r}`);
          continue;
        }
        region.set(r.r, id);
        for (const [k, v] of Object.entries(r.props ?? {}))
          t.setProperty(id, k, v);
      }
      const end = (name: string) => {
        if (!name.startsWith('#')) return region.get(name);
        const imageId = ids[Number(name.slice(1))];
        return imageId ? imageEl.get(imageId) : undefined;
      };
      for (const e of sheet.edges) {
        const a = end(e.from);
        const b = end(e.to);
        const id = a && b && t.connect(a, b, e.relation, e.direction ?? 'none');
        if (!id) {
          failed.push(`edge ${e.from} -> ${e.to}`);
          continue;
        }
        if (e.confidence) t.setProperty(id, 'confidence', e.confidence);
        if (e.note) t.setProperty(id, 'note', e.note);
        for (const [k, v] of Object.entries(e.props ?? {}))
          t.setProperty(id, k, v);
      }
      t.zoomToFit();
      return failed;
    },
    { sheet, ids },
  );
  if (drawn.length) throw new Error(`${sheet.name}: ${drawn.join(', ')}`);
  // The room saves once it goes quiet; leave only after the last emit is old.
  await page.waitForFunction(
    () => {
      const at = (window as unknown as ToolWindow).__digsite.syncStatus()
        .lastEmitAt;
      return at !== null && Date.now() - at > 4000;
    },
    undefined,
    { timeout: 30_000 },
  );
  console.log('sheet', sheet.name, made.json.id);
}
await browser.close();
