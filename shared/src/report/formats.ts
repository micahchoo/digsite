// A report's data in the formats other tools read (docs/roadmap.md "Report
// export", R5). One definition, used by the viewer inside a report file
// (its Data section) and by a kept report's evidence bundle on the server,
// so the two never disagree.
//
//   annotations.jsonld  W3C Web Annotation (https://www.w3.org/TR/annotation-model/).
//                       A region is an xywh=percent: FragmentSelector, which
//                       is exactly a fraction; a picture is urn:sha256:<hash>,
//                       so it names the original's bytes, not a server.
//   claims.csv          one row per claim, RFC 4180.
//   graph.graphml       pictures and connections, for Gephi and yEd.
//
// Pure.
import type { Properties } from '../sheet/elements.ts';
import {
  type ReportClaim,
  type ReportData,
  type ReportEnd,
  claimLink,
} from './data.ts';
import { claimGroups, numbered } from './order.ts';

const pct = (n: number) => Number((n * 100).toFixed(4));

export const pictureUrn = (sha256: string) => `urn:sha256:${sha256}`;

function target(data: ReportData, end: ReportEnd) {
  const image = data.images.find((i) => i.id === end.imageId);
  const source = {
    id: pictureUrn(image?.sha256 ?? end.imageId),
    type: 'Image',
    label: image?.name ?? 'picture',
  };
  if (!end.fraction) return source;
  const f = end.fraction;
  return {
    type: 'SpecificResource',
    source,
    selector: {
      type: 'FragmentSelector',
      conformsTo: 'http://www.w3.org/TR/media-frags/',
      value: `xywh=percent:${pct(f.fx)},${pct(f.fy)},${pct(f.fw)},${pct(f.fh)}`,
    },
  };
}

function person(p: { name: string } | null) {
  return p ? { type: 'Person', name: p.name } : undefined;
}

function annotation(data: ReportData, claim: ReportClaim) {
  const id = claimLink(data, claim);
  const bodies: Record<string, unknown>[] = [];
  if (claim.term)
    bodies.push({
      type: 'TextualBody',
      value: claim.term,
      purpose: claim.kind === 'region' ? 'tagging' : 'classifying',
    });
  if (claim.note)
    bodies.push({
      type: 'TextualBody',
      value: claim.note,
      purpose: 'commenting',
    });
  return {
    id,
    type: 'Annotation',
    motivation: claim.kind === 'region' ? 'tagging' : 'linking',
    ...(bodies.length
      ? { body: bodies.length === 1 ? bodies[0] : bodies }
      : {}),
    target:
      claim.ends.length === 1
        ? target(data, claim.ends[0] as ReportEnd)
        : claim.ends.map((end) => target(data, end)),
    ...(claim.made
      ? { creator: person(claim.made), created: claim.made.at }
      : {}),
    ...(claim.edited ? { modified: claim.edited.at } : {}),
    'digsite:kind': claim.kind,
    ...(claim.kind === 'connection'
      ? { 'digsite:direction': claim.direction ?? 'none' }
      : {}),
    ...(claim.confidence ? { 'digsite:confidence': claim.confidence } : {}),
    ...(claim.typed !== claim.term ? { 'digsite:typed': claim.typed } : {}),
    ...(claim.dangling ? { 'digsite:dangling': claim.dangling } : {}),
    ...(Object.keys(claim.properties).length
      ? { 'digsite:properties': claim.properties }
      : {}),
  };
}

/** Every claim, and every reply as an annotation replying to its claim. */
export function toWebAnnotation(data: ReportData): Record<string, unknown> {
  const groups = claimGroups(data);
  const order = numbered(groups);
  const claims = [...data.claims].sort(
    (a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0),
  );
  const items: Record<string, unknown>[] = [];
  for (const claim of claims) {
    items.push(annotation(data, claim));
    claim.replies.forEach((r, i) =>
      items.push({
        id: `${claimLink(data, claim)}#reply-${i + 1}`,
        type: 'Annotation',
        motivation: 'replying',
        body: { type: 'TextualBody', value: r.text },
        target: claimLink(data, claim),
        creator: { type: 'Person', name: r.name },
        created: r.at,
      }),
    );
  }
  return {
    '@context': [
      'http://www.w3.org/ns/anno.jsonld',
      { digsite: `${data.origin}/ns/report#` },
    ],
    id: data.id
      ? `${data.origin}/reports/${data.id}`
      : `urn:digsite:report:${data.at}`,
    type: 'AnnotationCollection',
    label: data.title,
    generator: { type: 'Software', name: data.format },
    generated: data.at,
    total: items.length,
    first: { type: 'AnnotationPage', startIndex: 0, items },
  };
}

/** RFC 4180: a field with a comma, quote or line break goes in quotes, and
 * a quote inside doubles. */
export function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

const props = (p: Properties) =>
  Object.keys(p).length ? JSON.stringify(p) : '';

export const CSV_COLUMNS = [
  'n',
  'kind',
  'says',
  'written_as',
  'from',
  'from_region',
  'to',
  'to_region',
  'direction',
  'confidence',
  'why',
  'properties',
  'sheet',
  'added_by',
  'added_at',
  'dangling',
  'from_sha256',
  'to_sha256',
  'link',
] as const;

export function toCsv(data: ReportData): string {
  const n = numbered(claimGroups(data));
  const images = new Map(data.images.map((i) => [i.id, i]));
  const sheets = new Map(data.sheets.map((s) => [s.id, s.name]));
  const rows = [...data.claims]
    .sort((a, b) => (n.get(a.key) ?? 0) - (n.get(b.key) ?? 0))
    .map((c) => {
      const [a, b] = c.ends;
      const img = (e?: ReportEnd) => (e ? images.get(e.imageId) : undefined);
      return [
        n.get(c.key),
        c.kind,
        c.term,
        c.typed === c.term ? '' : c.typed,
        img(a)?.name ?? '',
        a?.label ?? '',
        c.kind === 'connection' ? (img(b)?.name ?? '') : '',
        c.kind === 'connection' ? (b?.label ?? '') : '',
        c.direction ?? '',
        c.confidence ?? '',
        c.note,
        props(c.properties),
        sheets.get(c.sheetId) ?? '',
        c.made?.name ?? '',
        c.made?.at ?? '',
        c.dangling ?? '',
        img(a)?.sha256 ?? '',
        c.kind === 'connection' ? (img(b)?.sha256 ?? '') : '',
        claimLink(data, c),
      ];
    });
  return `${[CSV_COLUMNS as readonly unknown[], ...rows]
    .map((r) => r.map(csvField).join(','))
    .join('\r\n')}\r\n`;
}

const x = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

/** Pictures as nodes, connections as edges. A connection that points one
 * way is drawn source to target (a `reverse` one is turned round), and one
 * that points both ways or neither says so in `direction`. */
export function toGraphMl(data: ReportData): string {
  const sheets = new Map(data.sheets.map((s) => [s.id, s.name]));
  const keys = [
    ['name', 'node', 'string'],
    ['sha256', 'node', 'string'],
    ['relation', 'edge', 'string'],
    ['direction', 'edge', 'string'],
    ['confidence', 'edge', 'string'],
    ['why', 'edge', 'string'],
    ['sheet', 'edge', 'string'],
    ['link', 'edge', 'string'],
  ];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<graphml xmlns="http://graphml.graphdrawing.org/xmlns">',
    ...keys.map(
      ([name, on, type]) =>
        `  <key id="${name}" for="${on}" attr.name="${name}" attr.type="${type}"/>`,
    ),
    `  <graph id="${x(data.title)}" edgedefault="directed">`,
  ];
  for (const img of data.images)
    lines.push(
      `    <node id="${x(img.id)}"><data key="name">${x(img.name)}</data><data key="sha256">${x(img.sha256)}</data></node>`,
    );
  for (const c of data.claims) {
    const [a, b] = c.ends;
    if (c.kind !== 'connection' || !a || !b) continue;
    const [from, to] = c.direction === 'reverse' ? [b, a] : [a, b];
    lines.push(
      `    <edge id="${x(c.key)}" source="${x(from.imageId)}" target="${x(to.imageId)}"><data key="relation">${x(c.term)}</data><data key="direction">${x(c.direction === 'reverse' ? 'forward' : (c.direction ?? 'none'))}</data><data key="confidence">${x(c.confidence ?? '')}</data><data key="why">${x(c.note)}</data><data key="sheet">${x(sheets.get(c.sheetId) ?? '')}</data><data key="link">${x(claimLink(data, c))}</data></edge>`,
    );
  }
  lines.push('  </graph>', '</graphml>', '');
  return lines.join('\n');
}

/** The formats a report carries, by file name. */
export function reportFiles(data: ReportData): Record<string, string> {
  return {
    'report.json': `${JSON.stringify(data, null, 2)}\n`,
    'annotations.jsonld': `${JSON.stringify(toWebAnnotation(data), null, 2)}\n`,
    'claims.csv': toCsv(data),
    'graph.graphml': toGraphMl(data),
  };
}
