import { describe, expect, test } from 'bun:test';
import { reportChanges } from '../src/report/changes.ts';
import {
  REPORT_FORMAT,
  type ReportClaim,
  type ReportData,
  type ReportImage,
  anchorOf,
  isReportData,
} from '../src/report/data.ts';
import { renderDocument, scopeSentence } from '../src/report/document.ts';
import {
  claimGroups,
  disagreeingPairs,
  numbered,
  otherVoices,
} from '../src/report/order.ts';
import { inReadingOrder } from '../src/sheet/reading-order.ts';

const img = (id: string, name = id): ReportImage => ({
  id,
  name,
  width: 400,
  height: 200,
  sha256: `sha-${id}`,
  missing: false,
  properties: {},
});

function connection(
  key: string,
  a: string,
  b: string,
  over: Partial<ReportClaim> = {},
): ReportClaim {
  return {
    key,
    sheetId: 's1',
    elementId: key,
    kind: 'connection',
    term: 'same place',
    typed: 'same place',
    direction: 'forward',
    confidence: null,
    note: '',
    properties: {},
    made: null,
    edited: null,
    ends: [
      { imageId: a, regionKey: null, label: null, fraction: null },
      { imageId: b, regionKey: null, label: null, fraction: null },
    ],
    dangling: null,
    replies: [],
    ...over,
  };
}

function region(key: string, on: string, label: string): ReportClaim {
  return {
    ...connection(key, on, on),
    kind: 'region',
    term: label,
    typed: label,
    direction: null,
    ends: [
      {
        imageId: on,
        regionKey: key,
        label,
        fraction: { fx: 0.25, fy: 0.5, fw: 0.5, fh: 0.25 },
      },
    ],
  };
}

function report(
  claims: ReportClaim[],
  over: Partial<ReportData> = {},
): ReportData {
  return {
    format: REPORT_FORMAT,
    id: null,
    title: 'First pass',
    scope: { kind: 'sheet', sheetId: 's1' },
    board: { id: 'b1', name: 'Chimneys' },
    by: 'Ada',
    at: '2026-09-23T10:00:00.000Z',
    origin: 'https://dig.example',
    sheets: [{ id: 's1', name: 'First pass', savedAt: null }],
    images: [img('a'), img('b'), img('c')],
    claims,
    aliases: { label: {}, relation: {} },
    scene: null,
    path: null,
    ...over,
  };
}

const MEDIA = { pictures: {}, tokensCss: ':root{--accent:#9a5a00}' };

describe('reading order', () => {
  test('rows top to bottom, a row left to right', () => {
    const at = (id: string, x: number, y: number) => ({
      id,
      x,
      y,
      width: 100,
      height: 100,
    });
    const order = inReadingOrder([
      at('d', 0, 300),
      at('b', 200, 10),
      at('a', 0, 40),
      at('c', 400, 0),
    ]);
    expect(order.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('claim order', () => {
  test('connections before regions, the biggest term first, then reading order', () => {
    const data = report([
      region('r1', 'a', 'chimney'),
      connection('x', 'b', 'c', { term: 'copy of', typed: 'copy of' }),
      connection('y', 'b', 'c'),
      connection('z', 'a', 'b'),
      connection('u', 'a', 'c', { term: '', typed: '' }),
    ]);
    const groups = claimGroups(data);
    expect(groups.map((g) => [g.kind, g.term])).toEqual([
      ['connection', 'same place'],
      ['connection', 'copy of'],
      ['connection', ''],
      ['region', 'chimney'],
    ]);
    expect(groups[0]?.claims.map((c) => c.key)).toEqual(['z', 'y']);
    expect([...numbered(groups).entries()]).toEqual([
      ['z', 1],
      ['y', 2],
      ['x', 3],
      ['u', 4],
      ['r1', 5],
    ]);
  });

  test('a path reads step by step, with an empty step kept', () => {
    const data = report(
      [connection('ab', 'b', 'a'), connection('bc2', 'b', 'c')],
      {
        scope: { kind: 'path', boardId: 'b1', from: 'a', to: 'c' },
        path: ['a', 'b', 'c'],
      },
    );
    const groups = claimGroups(data);
    expect(groups.map((g) => g.term)).toEqual(['a to b', 'b to c']);
    expect(groups.map((g) => g.claims.map((c) => c.key))).toEqual([
      ['ab'],
      ['bc2'],
    ]);
    expect(scopeSentence(data)).toContain('in 2 steps');
  });
});

describe('other voices on a pair', () => {
  test('same relation drawn backwards agrees; another relation disagrees', () => {
    const data = report([
      connection('one', 'a', 'b'),
      connection('two', 'b', 'a', { sheetId: 's2', direction: 'reverse' }),
      connection('three', 'a', 'b', {
        sheetId: 's3',
        term: 'copy of',
        typed: 'copy of',
      }),
      connection('alone', 'b', 'c'),
    ]);
    const voices = otherVoices(data);
    expect(voices.get('one')).toEqual([
      { key: 'two', sheetId: 's2', agreement: 'agree' },
      { key: 'three', sheetId: 's3', agreement: 'disagree' },
    ]);
    expect(voices.has('alone')).toBe(false);
    expect(disagreeingPairs(data)).toBe(1);
  });
});

describe('the document', () => {
  test('escapes everything typed on a sheet', () => {
    const html = renderDocument(
      report([
        connection('x', 'a', 'b', {
          term: '<img src=x onerror=alert(1)>',
          note: '"quoted" & <b>',
        }),
      ]),
      MEDIA,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;b&gt;');
  });

  test('the data block cannot close its own script', () => {
    const html = renderDocument(
      report([
        connection('x', 'a', 'b', { note: '</script><script>alert(1)' }),
      ]),
      MEDIA,
    );
    const block = html.slice(html.indexOf('id="digsite-report"'));
    expect(block.indexOf('</script>')).toBe(block.indexOf('</script>\n'));
    expect(html).toContain('\\u003c/script>');
  });

  test('each picture is carried once, and every crop is a view of it', () => {
    const data = report([
      region('r1', 'a', 'chimney'),
      connection('x', 'a', 'b'),
    ]);
    const pictures = {
      a: 'data:image/jpeg;base64,AAAA',
      b: 'data:image/jpeg;base64,BBBB',
    };
    const html = renderDocument(data, { ...MEDIA, pictures });
    expect(html.split('base64,AAAA').length - 1).toBe(1);
    // The region's crop: x 0.25*400, y 0.5*200, w 0.5*400, h 0.25*200.
    expect(html).toContain('viewBox="100 100 200 50" width="260" height="65"');
    expect(html).toContain('<rect x="100" y="100" width="200" height="50"');
    expect(html).toContain('<use href="#pic-0"/>');
  });

  test('a picture that is gone says so; a script URL never loads', () => {
    const data = report([connection('x', 'a', 'b')], {
      images: [{ ...img('a'), missing: true }, img('b'), img('c')],
    });
    const html = renderDocument(data, {
      ...MEDIA,
      pictures: { a: 'data:image/jpeg;base64,AAAA', b: 'javascript:alert(1)' },
    });
    expect(html).toContain('picture removed');
    expect(html).toContain('picture not available');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('base64,AAAA');
  });

  test('says what an alias renamed, what dangles, and who disagrees', () => {
    const data = report([
      connection('one', 'a', 'b', { typed: 'same location' }),
      connection('two', 'a', 'b', {
        sheetId: 's2',
        term: 'copy of',
        typed: 'copy of',
        dangling: 'a region it joined was deleted',
      }),
    ]);
    data.sheets.push({ id: 's2', name: 'Second look', savedAt: null });
    const html = renderDocument(data, MEDIA);
    expect(html).toContain(
      '“same location”, which this board reads as “same place”',
    );
    expect(html).toContain('a region it joined was deleted');
    expect(html).toContain('sheets disagree about 1 pair');
    // Two groups of one: alphabetical, so "copy of" is 1.
    expect(html).toContain(`<a href="#${anchorOf('one')}">2</a> (First pass)`);
    expect(html).toContain('https://dig.example/s/s1?claim=one');
  });

  test('carries its data for the viewer, and the data reads back', () => {
    const data = report([connection('x', 'a', 'b')]);
    const html = renderDocument(data, MEDIA);
    const json = html.match(
      /<script type="application\/json" id="digsite-report">(.*?)<\/script>/s,
    )?.[1];
    const back = JSON.parse(json ?? 'null');
    expect(isReportData(back)).toBe(true);
    expect(back).toEqual(data);
  });

  test('without a viewer there is no module script', () => {
    const html = renderDocument(report([]), MEDIA);
    expect(html).not.toContain('<script type="module">');
    expect(html).toContain('Nothing to report');
    const withViewer = renderDocument(report([]), {
      ...MEDIA,
      viewer: 'console.log("</script>")',
    });
    expect(withViewer).toContain(
      '<script type="module">console.log("<\\/script>")',
    );
  });
});

describe('changes since a kept report', () => {
  test('added, removed, changed by field, and the same', () => {
    const kept = report([
      connection('stays', 'a', 'b'),
      connection('goes', 'b', 'c'),
      connection('moves', 'a', 'c', { confidence: 'likely', note: 'x' }),
      region('r', 'a', 'chimney'),
    ]);
    const moved = region('r', 'a', 'chimney');
    const f = moved.ends[0]?.fraction;
    if (f) f.fx += 0.00001; // float noise from a save, not a move
    const now = report([
      connection('stays', 'a', 'b', { properties: {} }),
      connection('moves', 'a', 'c', { confidence: 'confirmed', note: 'x' }),
      moved,
      connection('new', 'c', 'a'),
    ]);
    const c = reportChanges(kept, now);
    expect(c.added.map((x) => x.key)).toEqual(['new']);
    expect(c.removed.map((x) => x.key)).toEqual(['goes']);
    expect(c.changed.map((x) => [x.key, x.fields])).toEqual([
      ['moves', ['confidence']],
    ]);
    expect(c.same).toBe(2);
  });

  test('a region moved, a reply added, an alias applied later', () => {
    const kept = report([region('r', 'a', 'stack')]);
    const now = report([
      {
        ...region('r', 'a', 'chimney'),
        typed: 'stack',
        replies: [{ name: 'Ada', at: '2026-09-23T10:00:00Z', text: 'Yes' }],
        ends: [
          {
            imageId: 'a',
            regionKey: 'r',
            label: 'chimney',
            fraction: { fx: 0.3, fy: 0.5, fw: 0.5, fh: 0.25 },
          },
        ],
      },
    ]);
    expect(reportChanges(kept, now).changed[0]?.fields).toEqual([
      'term',
      'ends',
      'replies',
    ]);
  });
});
