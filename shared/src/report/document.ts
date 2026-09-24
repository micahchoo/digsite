// A report as one HTML file (docs/roadmap.md "Report export"): the claims a
// scope gathered, each with the pictures it rests on, what it says, how
// sure, why, who said it, and what other sheets say about the same pair.
//
// Two layers. This file is the DOCUMENT: complete with no script, so it
// prints, mails and archives, and it is what a citation points at. The
// VIEWER (web/src/report/viewer-main.tsx), when the file carries it and a
// browser runs it, turns the document's figures into the app's own canvas.
// It reads the data from the JSON block this writes, never from the markup.
//
// Every picture is in the file once, as an SVG <image> in <defs>. Each crop
// and each context view is a <use> of it under its own viewBox, in the
// picture's own pixel units, so a region's fraction is drawn exactly, with
// no second copy of any pixel, and it prints.
//
// Pure. Every text is escaped; nothing typed on a sheet is markup.
import type { Properties } from '../sheet/elements.ts';
import {
  type ReportClaim,
  type ReportData,
  type ReportEnd,
  type ReportImage,
  anchorOf,
  claimLink,
} from './data.ts';
import {
  type ClaimGroup,
  claimGroups,
  disagreeingPairs,
  numbered,
  otherVoices,
} from './order.ts';

export type ReportMedia = {
  /** Image id → the picture as a data URL. An absent picture is drawn as
   * not available; the claim still reads. */
  pictures: Readonly<Record<string, string>>;
  /** web/src/theme/tokens.css: the file draws in the app's colours, light
   * and dark, and tokens.css stays the only place a colour is written. */
  tokensCss: string;
  /** The sheet as it stood, as a data URL: figure 1, which the viewer
   * replaces with the live sheet. */
  still?: string | null;
  /** The viewer bundle. Without it the file is the document alone. */
  viewer?: string | null;
};

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const e = escapeHtml;

/** Only these reach an attribute that loads or links something. */
export function safeUrl(url: string): string {
  return /^(https?:\/\/|data:image\/(png|jpeg|webp);base64,)/.test(url)
    ? url
    : '';
}

export function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? `${new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC`
    : '';
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** One sentence saying what the report gathered. */
export function scopeSentence(data: ReportData): string {
  const names = new Map(data.images.map((img) => [img.id, img.name]));
  const board = `the board ${data.board.name}`;
  const scope = data.scope;
  switch (scope.kind) {
    case 'sheet':
      return `Every claim on the sheet ${data.sheets[0]?.name ?? ''}, on ${board}.`;
    case 'selection':
      return `Claims chosen from the sheet ${data.sheets[0]?.name ?? ''}, on ${board}.`;
    case 'board':
      return `Every claim on ${board}, from ${plural(data.sheets.length, 'sheet')}.`;
    case 'relation':
      return `Every “${scope.relation}” connection on ${board}.`;
    case 'path': {
      const steps = Math.max(0, (data.path?.length ?? 1) - 1);
      return steps
        ? `How ${names.get(scope.from) ?? 'one picture'} and ${names.get(scope.to) ?? 'another'} are connected on ${board}, in ${plural(steps, 'step')}.`
        : `${names.get(scope.from) ?? 'One picture'} and ${names.get(scope.to) ?? 'another'} are not connected on ${board}.`;
    }
  }
}

const ARROW: Record<string, string> = {
  forward: '→',
  reverse: '←',
  both: '↔',
  none: '—',
};

/** The document's own id for a picture's <image>: by position, short. */
type Pictures = Map<string, { image: ReportImage; ref: string | null }>;

function picturesOf(data: ReportData, media: ReportMedia): Pictures {
  const out: Pictures = new Map();
  data.images.forEach((image, i) => {
    const src = image.missing ? '' : safeUrl(media.pictures[image.id] ?? '');
    out.set(image.id, { image, ref: src ? `pic-${i}` : null });
  });
  return out;
}

function defs(data: ReportData, media: ReportMedia, pics: Pictures): string {
  const images = data.images
    .map((image) => {
      const ref = pics.get(image.id)?.ref;
      if (!ref) return '';
      return `<image id="${ref}" href="${e(safeUrl(media.pictures[image.id] ?? ''))}" width="${image.width}" height="${image.height}" preserveAspectRatio="none"/>`;
    })
    .join('');
  return `<svg class="defs" width="0" height="0" aria-hidden="true"><defs>${images}</defs></svg>`;
}

const num = (n: number) => Number(n.toFixed(2));

/** A picture, or the part a fraction names, cut out of the one copy. */
function crop(pics: Pictures, end: ReportEnd, alt: string): string {
  const pic = pics.get(end.imageId);
  if (!pic?.ref) {
    const why = pic?.image.missing
      ? 'picture removed'
      : 'picture not available';
    return `<div class="missing" role="img" aria-label="${e(`${alt}: ${why}`)}">${why}</div>`;
  }
  const { width: W, height: H } = pic.image;
  const f = end.fraction ?? { fx: 0, fy: 0, fw: 1, fh: 1 };
  const w = Math.max(1, f.fw * W);
  const h = Math.max(1, f.fh * H);
  return `<svg class="crop" viewBox="${num(f.fx * W)} ${num(f.fy * H)} ${num(w)} ${num(h)}" style="aspect-ratio:${num(w)}/${num(h)}" role="img" aria-label="${e(alt)}"><use href="#${pic.ref}"/></svg>`;
}

/** The whole picture, the region outlined and the rest dimmed: where the
 * crop came from. */
function context(pics: Pictures, end: ReportEnd): string {
  const pic = pics.get(end.imageId);
  if (!pic?.ref || !end.fraction) return '';
  const { width: W, height: H } = pic.image;
  const f = end.fraction;
  const [x, y, w, h] = [f.fx * W, f.fy * H, f.fw * W, f.fh * H].map(num);
  return `<svg class="context" viewBox="0 0 ${W} ${H}" style="aspect-ratio:${W}/${H}" aria-hidden="true"><use href="#${pic.ref}"/><path class="dim" fill-rule="evenodd" d="M0 0H${W}V${H}H0Z M${x} ${y}h${w}v${h}h${-(w ?? 0)}Z"/><rect x="${x}" y="${y}" width="${w}" height="${h}" vector-effect="non-scaling-stroke"/></svg>`;
}

function endFigure(pics: Pictures, end: ReportEnd): string {
  const name = pics.get(end.imageId)?.image.name ?? 'picture';
  const alt = end.label ? `${end.label}, on ${name}` : name;
  return `<figure class="end">${crop(pics, end, alt)}${context(pics, end)}<figcaption>${
    end.label ? `<b>${e(end.label)}</b> on ` : ''
  }<a href="#p-${e(end.imageId)}">${e(name)}</a></figcaption></figure>`;
}

function value(v: unknown): string {
  return Array.isArray(v) ? v.join(', ') : String(v);
}

function propertyFacts(properties: Properties, skip: ReadonlySet<string>) {
  return Object.entries(properties)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `<dt>${e(k)}</dt><dd>${e(value(v))}</dd>`);
}

const CONFIDENCE_SAYS: Record<string, string> = {
  confirmed: 'confirmed',
  likely: 'likely',
  unverified: 'not checked yet',
};

function claimSection(
  data: ReportData,
  claim: ReportClaim,
  pics: Pictures,
  n: ReadonlyMap<string, number>,
  voices: ReturnType<typeof otherVoices>,
  sheetNames: ReadonlyMap<string, string>,
): string {
  const facts: string[] = [];
  const name = (end: ReportEnd | undefined) =>
    end ? (pics.get(end.imageId)?.image.name ?? 'picture') : 'picture';
  if (claim.dangling)
    facts.push(
      `<dt>No longer holds</dt><dd class="dangling">${e(claim.dangling)}</dd>`,
    );
  if (claim.kind === 'connection') {
    facts.push(
      `<dt>Says</dt><dd>${e(claim.term || 'nothing yet: the connection is unnamed')}</dd>`,
    );
  }
  if (claim.typed && claim.typed !== claim.term)
    facts.push(
      `<dt>Written as</dt><dd>“${e(claim.typed)}”, which this board reads as “${e(claim.term)}”</dd>`,
    );
  if (claim.confidence)
    facts.push(
      `<dt>How sure</dt><dd><span class="sure sure-${e(claim.confidence)}" aria-hidden="true"></span>${e(CONFIDENCE_SAYS[claim.confidence] ?? claim.confidence)}</dd>`,
    );
  if (claim.note) facts.push(`<dt>Why</dt><dd>${e(claim.note)}</dd>`);
  facts.push(...propertyFacts(claim.properties, new Set()));
  if (data.sheets.length > 1)
    facts.push(
      `<dt>Sheet</dt><dd>${e(sheetNames.get(claim.sheetId) ?? '')}</dd>`,
    );
  if (claim.made)
    facts.push(
      `<dt>Added</dt><dd>${e(claim.made.name)}, ${e(when(claim.made.at))}</dd>`,
    );
  if (claim.edited)
    facts.push(
      `<dt>Last changed</dt><dd>${e(claim.edited.name)}, ${e(when(claim.edited.at))}</dd>`,
    );
  const others = voices.get(claim.key) ?? [];
  if (others.length) {
    const say = (agreement: string) =>
      others
        .filter((v) => v.agreement === agreement)
        .map(
          (v) =>
            `<a href="#${anchorOf(v.key)}">${n.get(v.key) ?? '?'}</a> (${e(sheetNames.get(v.sheetId) ?? 'another sheet')})`,
        )
        .join(', ');
    const agree = say('agree');
    const disagree = say('disagree');
    if (agree) facts.push(`<dt>Agrees with</dt><dd>${agree}</dd>`);
    if (disagree)
      facts.push(
        `<dt>Disagrees with</dt><dd class="disagree">${disagree}</dd>`,
      );
  }

  const [a, b] = claim.ends;
  const title =
    claim.kind === 'connection'
      ? `${e(name(a))} ${ARROW[claim.direction ?? 'none']} ${e(name(b))}`
      : `${e(claim.term || 'Unlabelled region')} <span class="on">on ${e(name(a))}</span>`;
  const ends =
    claim.kind === 'connection' && a && b
      ? `${endFigure(pics, a)}<div class="arrow" aria-label="${e(claim.direction ?? 'none')}">${ARROW[claim.direction ?? 'none']}</div>${endFigure(pics, b)}`
      : claim.ends.map((end) => endFigure(pics, end)).join('');
  const replies = claim.replies.length
    ? `<h4>Discussion</h4><ol class="replies">${claim.replies
        .map(
          (r) =>
            `<li><b>${e(r.name)}</b> <time datetime="${e(r.at)}">${e(when(r.at))}</time><p>${e(r.text)}</p></li>`,
        )
        .join('')}</ol>`
    : '';
  const marks = [
    claim.dangling ? '<span class="mark mark-dangling">dangling</span>' : '',
    others.some((v) => v.agreement === 'disagree')
      ? '<span class="mark mark-disagree">disputed</span>'
      : '',
  ].join('');
  const link = safeUrl(claimLink(data, claim));
  return `<article class="claim${claim.dangling ? ' is-dangling' : ''}" id="${anchorOf(claim.key)}" data-key="${e(claim.key)}">
<h3><span class="n">${n.get(claim.key)}</span> ${title}${marks}</h3>
<div class="ends">${ends}</div>
${facts.length ? `<dl>${facts.join('')}</dl>` : ''}${replies}
${link ? `<p class="link"><a href="${e(link)}">Open this claim in digsite</a></p>` : ''}
</article>`;
}

function groupHeading(data: ReportData, group: ClaimGroup): string {
  const count = plural(
    group.claims.length,
    group.kind === 'connection' ? 'connection' : 'region',
  );
  if (data.path) return `${e(group.term)} <span class="count">${count}</span>`;
  const term =
    group.term ||
    (group.kind === 'connection'
      ? 'Unnamed connections'
      : 'Unlabelled regions');
  return `${e(term)} <span class="count">${count}</span>`;
}

/** The captured properties a reader checks a picture by, in words. */
const CAPTURED = [
  'taken',
  'taken_at',
  'camera',
  'lens',
  'focal_mm',
  'aperture',
  'exposure_s',
  'iso',
  'latitude',
  'longitude',
  'format',
  'derived_from',
  'derived_region',
];

function pictureEntry(image: ReportImage, pics: Pictures): string {
  const p = image.properties;
  const facts: string[] = [];
  const has = (k: string) => p[k] !== undefined && p[k] !== null && p[k] !== '';
  facts.push(`<dt>Size</dt><dd>${image.width} × ${image.height} px</dd>`);
  if (has('taken_at') || has('taken'))
    facts.push(`<dt>Taken</dt><dd>${e(value(p.taken_at ?? p.taken))}</dd>`);
  if (has('camera'))
    facts.push(`<dt>Camera</dt><dd>${e(value(p.camera))}</dd>`);
  if (has('lens')) facts.push(`<dt>Lens</dt><dd>${e(value(p.lens))}</dd>`);
  const settings = [
    has('focal_mm') ? `${value(p.focal_mm)} mm` : '',
    has('aperture') ? `f/${value(p.aperture)}` : '',
    has('exposure_s') ? `${value(p.exposure_s)} s` : '',
    has('iso') ? `ISO ${value(p.iso)}` : '',
  ].filter(Boolean);
  if (settings.length)
    facts.push(`<dt>Settings</dt><dd>${e(settings.join(' · '))}</dd>`);
  if (has('latitude') && has('longitude'))
    facts.push(
      `<dt>Place</dt><dd>${e(`${value(p.latitude)}, ${value(p.longitude)}`)}</dd>`,
    );
  if (has('format'))
    facts.push(`<dt>Came in as</dt><dd>${e(value(p.format))}</dd>`);
  if (has('derived_from'))
    facts.push(
      `<dt>Cut from</dt><dd>${e(value(p.derived_from))}${has('derived_region') ? ` (${e(value(p.derived_region))})` : ''}</dd>`,
    );
  facts.push(...propertyFacts(p, new Set(CAPTURED)));
  facts.push(`<dt>SHA-256</dt><dd class="hash">${e(image.sha256)}</dd>`);
  if (image.missing)
    facts.push('<dt>Now</dt><dd class="dangling">removed from the board</dd>');
  const thumb = crop(
    pics,
    { imageId: image.id, regionKey: null, label: null, fraction: null },
    image.name,
  );
  return `<article class="picture" id="p-${e(image.id)}"><div class="thumb">${thumb}</div><div><h3>${e(image.name)}</h3><dl>${facts.join('')}</dl></div></article>`;
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:var(--surface-app);color:var(--text-primary);font:var(--text-md)/1.55 var(--font-ui)}
.page{max-width:920px;margin:0 auto;padding:var(--space-8) var(--space-4) var(--space-12)}
a{color:var(--accent)}a:hover{color:var(--accent-hover)}
.defs{position:absolute;width:0;height:0;overflow:hidden}
.kicker{margin:0;color:var(--text-secondary);font-size:var(--text-xs);letter-spacing:.06em;text-transform:uppercase}
h1{margin:var(--space-1) 0 var(--space-2);font-size:var(--text-3xl);line-height:1.15;text-wrap:balance}
.meta{margin:0;color:var(--text-secondary);font-size:var(--text-sm)}
.cite{margin:var(--space-2) 0 0;font-size:var(--text-xs);color:var(--text-faint)}
.cite code,.hash{font-family:var(--font-mono);font-size:var(--text-2xs);overflow-wrap:anywhere}
.summary{display:flex;flex-wrap:wrap;gap:var(--space-2);margin:var(--space-4) 0 0;padding:0;list-style:none}
.summary li{padding:2px var(--space-3);border:1px solid var(--line);border-radius:var(--radius-full);background:var(--surface-raised);font-size:var(--text-sm)}
.summary .is-disagree{border-color:var(--danger);color:var(--danger)}
nav.contents{margin:var(--space-6) 0;padding:var(--space-4);border:1px solid var(--line);border-radius:var(--radius-l);background:var(--surface-raised)}
nav.contents h2{margin:0 0 var(--space-2);font-size:var(--text-sm);color:var(--text-secondary);border:0;padding:0}
nav.contents ol{margin:0;padding-left:var(--space-5);columns:2 220px;font-size:var(--text-sm)}
.sheet-figure{margin:var(--space-6) 0;padding:var(--space-3);border:1px solid var(--line);border-radius:var(--radius-l);background:var(--surface-canvas)}
.sheet-figure img{display:block;width:100%;height:auto;border-radius:var(--radius-m)}
figcaption{font-size:var(--text-xs);color:var(--text-secondary);margin-top:var(--space-1);overflow-wrap:anywhere}
h2{margin:var(--space-10) 0 var(--space-3);padding-bottom:var(--space-2);border-bottom:1px solid var(--line-strong);font-size:var(--text-xl)}
.count{color:var(--text-secondary);font-size:var(--text-sm);font-weight:400;margin-left:var(--space-2)}
.claim,.picture{margin:0 0 var(--space-4);padding:var(--space-4);border:1px solid var(--line);border-radius:var(--radius-l);background:var(--surface-raised);box-shadow:var(--shadow-s);break-inside:avoid}
.claim.is-dangling{border-style:dashed}
.claim:target{outline:2px solid var(--focus-ring);outline-offset:2px}
h3{margin:0 0 var(--space-3);font-size:var(--text-lg);line-height:1.3;overflow-wrap:anywhere}
h3 .n{display:inline-grid;place-items:center;min-width:1.7em;height:1.7em;margin-right:var(--space-1);border-radius:var(--radius-full);background:var(--surface-sunken);font-size:var(--text-xs);font-variant-numeric:tabular-nums;vertical-align:.15em}
h3 .on{color:var(--text-secondary);font-weight:400}
.mark{margin-left:var(--space-2);padding:1px var(--space-2);border-radius:var(--radius-full);font-size:var(--text-2xs);font-weight:600;letter-spacing:.04em;text-transform:uppercase;vertical-align:.2em}
.mark-dangling{background:var(--surface-sunken);color:var(--text-secondary)}
.mark-disagree{border:1px solid var(--danger);color:var(--danger)}
h4{margin:var(--space-4) 0 var(--space-1);font-size:var(--text-sm);color:var(--text-secondary)}
.ends{display:flex;align-items:center;gap:var(--space-4);flex-wrap:wrap}
.arrow{font-size:var(--text-2xl);color:var(--claim-edge)}
figure.end{margin:0;width:min(260px,100%);display:grid;grid-template-columns:1fr auto;gap:var(--space-2);align-items:end}
figure.end figcaption{grid-column:1/-1}
.crop{display:block;width:100%;max-height:240px;border-radius:var(--radius-m);border:1px solid var(--line);background:var(--placeholder)}
.context{display:block;width:64px;border-radius:var(--radius-s);border:1px solid var(--line)}
.context .dim{fill:rgba(0,0,0,.45)}
.context rect{fill:none;stroke:var(--claim-own);stroke-width:2}
.missing{display:grid;place-items:center;width:100%;aspect-ratio:4/3;border-radius:var(--radius-m);background:var(--placeholder);color:var(--text-secondary);font-size:var(--text-xs)}
dl{display:grid;grid-template-columns:minmax(7em,auto) 1fr;gap:var(--space-1) var(--space-3);margin:var(--space-4) 0 0;font-size:var(--text-base)}
dt{color:var(--text-secondary)}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.dangling,.disagree{color:var(--danger)}
.sure{display:inline-block;width:28px;margin-right:var(--space-2);border-top:2px solid var(--claim-edge);vertical-align:middle}
.sure-likely{border-top-style:dashed}.sure-unverified{border-top-style:dotted}
.replies{margin:0;padding-left:var(--space-5);font-size:var(--text-base)}
.replies p{margin:2px 0 var(--space-2);white-space:pre-wrap}
time{color:var(--text-secondary);font-size:var(--text-xs)}
.link{margin:var(--space-3) 0 0;font-size:var(--text-sm)}
.picture{display:grid;grid-template-columns:140px 1fr;gap:var(--space-4)}
.picture h3{font-size:var(--text-md)}
.picture dl{margin:0;font-size:var(--text-sm)}
footer{margin-top:var(--space-10);color:var(--text-faint);font-size:var(--text-xs)}
@media (max-width:560px){h1{font-size:var(--text-2xl)}.picture{grid-template-columns:1fr}.picture .thumb{max-width:220px}dl{grid-template-columns:1fr}dt{margin-top:var(--space-1)}}
@media print{
  @page{margin:16mm}
  body{background:#fff;color:#000;font-size:11pt}
  .page{max-width:none;padding:0}
  .claim,.picture{box-shadow:none;border-color:#bbb}
  nav.contents{break-after:page}
  h2{break-after:avoid}
  .link a::after{content:" (" attr(href) ")";font-size:8pt;color:#555;overflow-wrap:anywhere}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;

/** The data the viewer reads, as JSON that cannot close its own script. */
export function dataScript(data: ReportData): string {
  return `<script type="application/json" id="digsite-report">${JSON.stringify(
    data,
  ).replace(/</g, '\\u003c')}</script>`;
}

export function renderDocument(data: ReportData, media: ReportMedia): string {
  const pics = picturesOf(data, media);
  const groups = claimGroups(data);
  const n = numbered(groups);
  const voices = otherVoices(data);
  const disputed = disagreeingPairs(data);
  const sheetNames = new Map(data.sheets.map((s) => [s.id, s.name]));
  const connections = data.claims.filter((c) => c.kind === 'connection').length;
  const regions = data.claims.length - connections;
  const dangling = data.claims.filter((c) => c.dangling).length;
  const origin = safeUrl(data.origin);
  const home =
    data.scope.kind === 'sheet' || data.scope.kind === 'selection'
      ? `${origin}/s/${data.scope.sheetId}`
      : `${origin}/b/${data.board.id}`;

  const summary = [
    `<li>${plural(connections, 'connection')}</li>`,
    `<li>${plural(regions, 'region')}</li>`,
    `<li>${plural(data.images.length, 'picture')}</li>`,
    data.sheets.length > 1
      ? `<li>${plural(data.sheets.length, 'sheet')}</li>`
      : '',
    disputed
      ? `<li class="is-disagree">sheets disagree about ${plural(disputed, 'pair')}</li>`
      : '',
    dangling ? `<li>${plural(dangling, 'claim')} dangling</li>` : '',
  ].join('');

  const contents = groups.length
    ? `<nav class="contents" aria-labelledby="contents-h"><h2 id="contents-h">Contents</h2><ol>${groups
        .map(
          (g, i) => `<li><a href="#g-${i}">${groupHeading(data, g)}</a></li>`,
        )
        .join('')}<li><a href="#pictures">Pictures</a></li></ol></nav>`
    : '';

  const still = media.still ? safeUrl(media.still) : '';
  const figure = still
    ? `<figure class="sheet-figure" id="sheet"><img src="${e(still)}" alt="${e(`The sheet ${data.sheets[0]?.name ?? ''} as it stood when the report was made`)}"><figcaption>Figure 1. The sheet ${e(data.sheets[0]?.name ?? '')} as it stood at ${e(when(data.at))}.</figcaption></figure>`
    : '';

  const body = groups.length
    ? groups
        .map(
          (g, i) =>
            `<section class="group" id="g-${i}"><h2>${groupHeading(data, g)}</h2>${
              g.claims.length
                ? g.claims
                    .map((c) =>
                      claimSection(data, c, pics, n, voices, sheetNames),
                    )
                    .join('\n')
                : '<p class="meta">No connection on the board joins these two pictures directly.</p>'
            }</section>`,
        )
        .join('\n')
    : '<p class="meta">Nothing to report: the scope holds no claims.</p>';

  const kept = data.id
    ? `Report <code>${e(data.id)}</code>, kept by digsite; this file is a copy of it.`
    : 'This file is the only copy of this report.';
  const read = data.sheets
    .filter((s) => s.savedAt)
    .map((s) => `${e(s.name)} saved ${e(when(s.savedAt ?? ''))}`)
    .join('; ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="digsite ${e(data.format)}">
<title>${e(data.title)} · ${e(data.board.name)}</title>
<style>${media.tokensCss}</style>
<style>${STYLE}</style>
</head><body>
${defs(data, media, pics)}
<div class="page">
<header class="masthead">
<p class="kicker">Report · ${e(data.board.name)}</p>
<h1>${e(data.title)}</h1>
<p class="meta">${e(scopeSentence(data))} Made by ${e(data.by)}, ${e(when(data.at))}.${home ? ` <a href="${e(home)}">Open in digsite</a>` : ''}</p>
<ul class="summary">${summary}</ul>
<p class="cite">${kept}${read ? ` Read from: ${read}.` : ''}</p>
</header>
${contents}
${figure}
<main id="claims">
${body}
</main>
<section id="pictures"><h2>Pictures <span class="count">${plural(data.images.length, 'picture')}</span></h2>
${data.images.map((img) => pictureEntry(img, pics)).join('\n')}
</section>
<footer>Made with digsite. Data format ${e(data.format)}; the data is inside this file.</footer>
</div>
${dataScript(data)}
${media.viewer ? `<script type="module">${media.viewer.replace(/<\/script/gi, '<\\/script')}</script>` : ''}
</body></html>
`;
}
