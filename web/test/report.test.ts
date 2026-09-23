// A sheet's claims as one document (sheet/report.ts).
import { describe, expect, test } from 'bun:test';
import { buildReport, escapeHtml } from '../src/sheet/report.ts';

const base = {
  sheetName: 'First pass',
  boardName: 'Field',
  by: 'Micah',
  at: '2026-09-23T10:00:00.000Z',
  link: 'https://digsite.example/s/1',
};

describe('buildReport', () => {
  test('a connection shows both ends, what it says, how sure, why, who and the discussion', () => {
    const html = buildReport({
      ...base,
      claims: [
        {
          kind: 'connection',
          term: 'same place',
          direction: 'forward',
          confidence: 'likely',
          note: 'the chimney lines up',
          made: { name: 'Ana', at: '2026-09-22T09:00:00.000Z' },
          ends: [
            { name: 'a.png', crop: 'data:image/jpeg;base64,AAAA' },
            { name: 'b.png', label: 'roof', crop: null },
          ],
          properties: { source: 'archive 12' },
          replies: [{ name: 'Ben', at: '2026-09-22T10:00:00.000Z', text: 'Agreed.' }],
          link: 'https://digsite.example/s/1?claim=e1',
        },
      ],
    });
    for (const expected of [
      'same place',
      'likely',
      'the chimney lines up',
      'Ana, 2026-09-22 09:00 UTC',
      'data:image/jpeg;base64,AAAA',
      'picture not available',
      '<b>roof</b>',
      'archive 12',
      'Agreed.',
      '?claim=e1',
      '1 connection, 0 regions',
    ])
      expect(html).toContain(expected);
  });

  test('nothing typed on a sheet becomes markup', () => {
    const html = buildReport({
      ...base,
      sheetName: '<script>alert(1)</script>',
      claims: [
        {
          kind: 'region',
          term: '"><img src=x onerror=alert(1)>',
          ends: [{ name: 'x', crop: 'javascript:alert(1)' }],
          properties: {},
          replies: [],
          link: 'javascript:alert(2)',
        },
      ],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('javascript:');
  });

  test('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
