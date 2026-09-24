// A report brought back in as a sheet (report/import.ts, sheet/import-ops.ts).
import { describe, expect, test } from 'bun:test';
import {
  REPORT_FORMAT,
  type ReportClaim,
  type ReportData,
  SHEET_LIMIT,
} from '@digsite/shared';
import { importPlan, readReportFile } from '../src/report/import.ts';
import type { SceneElement } from '../src/sheet/canvas/types.ts';
import { importOps } from '../src/sheet/import-ops.ts';

const image = (id: string) => ({
  id,
  name: `${id}.jpg`,
  width: 400,
  height: 200,
  // Hex of the id's characters, so no two ids share a hash.
  sha256: [...id]
    .map((ch) => ch.charCodeAt(0).toString(16))
    .join('')
    .padEnd(64, 'f'),
  missing: false,
  properties: {},
});

const claim = (over: Partial<ReportClaim>): ReportClaim => ({
  key: 'k',
  sheetId: 's',
  elementId: 'e',
  kind: 'connection',
  term: 'same place',
  typed: 'same location',
  direction: 'forward',
  confidence: 'likely',
  note: 'the chimney',
  properties: {},
  made: null,
  edited: null,
  ends: [],
  dangling: null,
  replies: [],
  ...over,
});

const regionEnd = (imageId: string, key: string) => ({
  imageId,
  regionKey: key,
  label: 'chimney',
  fraction: { fx: 0.25, fy: 0.5, fw: 0.5, fh: 0.25 },
});
const wholeEnd = (imageId: string) => ({
  imageId,
  regionKey: null,
  label: null,
  fraction: null,
});

function report(claims: ReportClaim[], images = ['a', 'b', 'c']): ReportData {
  return {
    format: REPORT_FORMAT,
    id: null,
    title: 'First pass',
    scope: { kind: 'sheet', sheetId: 's' },
    board: { id: 'b', name: 'Elsewhere' },
    by: 'Ada',
    at: '2026-09-23T10:00:00.000Z',
    origin: 'https://dig.example',
    sheets: [{ id: 's', name: 'First pass', savedAt: null }],
    images: images.map(image),
    claims,
    aliases: { label: {}, relation: {} },
    scene: {
      sheetId: 's',
      elements: [
        {
          id: 'pa',
          x: 100,
          y: 50,
          width: 400,
          height: 200,
          customData: { kind: 'image', imageId: 'a' },
        },
      ],
    },
    path: null,
  };
}

const held = (...ids: string[]) =>
  ids.map((id) => ({ id: `here-${id}`, sha256: image(id).sha256 }));

describe('readReportFile', () => {
  test('reads a report file or its JSON, and refuses anything else', () => {
    const data = report([]);
    const html = `<html><script type="application/json" id="digsite-report">${JSON.stringify(data)}</script></html>`;
    expect(readReportFile(html)?.title).toBe('First pass');
    expect(readReportFile(JSON.stringify(data))?.title).toBe('First pass');
    expect(readReportFile('{"format":"something/else"}')).toBeNull();
    expect(readReportFile('<html>no report</html>')).toBeNull();
  });
});

describe('importPlan', () => {
  test('lands a claim on the pictures held by hash, and says what could not', () => {
    const plan = importPlan(
      report([
        claim({ key: 'x', ends: [wholeEnd('a'), wholeEnd('b')] }),
        claim({ key: 'y', ends: [wholeEnd('b'), wholeEnd('c')] }),
        claim({
          key: 'r',
          kind: 'region',
          term: 'chimney',
          typed: 'stack',
          ends: [regionEnd('a', 'r')],
        }),
      ]),
      held('a', 'b'),
    );
    expect(plan.claims.map((c) => [c.kind, c.term])).toEqual([
      ['region', 'stack'],
      ['connection', 'same location'],
    ]);
    expect(plan.claims[1]?.ends.map((e) => e.imageId)).toEqual([
      'here-a',
      'here-b',
    ]);
    expect(plan.skipped).toEqual([
      'Connection “same location”: c.jpg is not on this board',
    ]);
    expect(plan.imageIds).toEqual(['here-a', 'here-b']);
    // The report's arrangement, as centres.
    expect(plan.positions).toEqual({ 'here-a': { x: 300, y: 150 } });
  });

  test('stops at a sheet’s limit and says so', () => {
    const ids = Array.from({ length: SHEET_LIMIT + 2 }, (_, i) => `p${i}`);
    const claims = ids.map((id, i) =>
      claim({
        key: id,
        ends: [wholeEnd(id), wholeEnd(ids[(i + 1) % ids.length] as string)],
      }),
    );
    const plan = importPlan(report(claims, ids), held(...ids));
    expect(plan.imageIds.length).toBe(SHEET_LIMIT);
    expect(plan.skipped.some((s) => s.includes(`at most ${SHEET_LIMIT}`))).toBe(
      true,
    );
  });
});

describe('importOps', () => {
  const picture = (id: string, imageId: string, x: number): SceneElement =>
    ({
      id,
      type: 'image',
      x,
      y: 0,
      width: 400,
      height: 200,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      updated: 0,
      groupIds: [],
      boundElements: null,
      startBinding: null,
      endBinding: null,
      points: [],
      startArrowhead: null,
      endArrowhead: null,
      customData: { kind: 'image', imageId },
    }) as SceneElement;

  test('one region per region key, and the edge binds to it', () => {
    const plan = importPlan(
      report([
        claim({
          key: 'r',
          kind: 'region',
          typed: 'stack',
          ends: [regionEnd('a', 'r')],
        }),
        claim({ key: 'x', ends: [regionEnd('a', 'r'), wholeEnd('b')] }),
      ]),
      held('a', 'b'),
    );
    let n = 0;
    const { ops, claims } = importOps(
      plan.claims,
      [picture('pa', 'here-a', 0), picture('pb', 'here-b', 500)],
      { id: 'u', name: 'Bo', at: '2026-09-24T00:00:00.000Z' },
      () => `new-${++n}`,
    );
    expect(claims).toBe(2);
    expect(ops.map((o) => o.op)).toEqual(['addRegion', 'addEdge']);
    expect(ops[0]).toMatchObject({
      id: 'new-1',
      imageId: 'here-a',
      label: 'stack',
      rect: { x: 100, y: 100, width: 200, height: 50 },
      made: { name: 'Bo' },
    });
    expect(ops[1]).toMatchObject({
      fromId: 'new-1',
      toId: 'pb',
      relation: 'same location',
      direction: 'forward',
      confidence: 'likely',
      note: 'the chimney',
      toRect: { x: 500, y: 0, width: 400, height: 200 },
    });
  });
});
