// A sheet's claims as one document someone else can check without the app
// (docs/roadmap.md horizon 5, "Show the work"): every connection with its
// two ends as pictures, what it says, how sure, why, who said it and when,
// and what was said about it; every region with its crop and label. One
// self-contained HTML file: the pictures are inline, so it can be mailed,
// archived or printed and still show what the claims rest on.
//
// Pure: it is handed the claims with their crops already drawn, and returns
// the document. Every text is escaped; nothing typed on a sheet is markup.

export interface ReportPerson {
  name: string;
  at: string;
}

export interface ReportEnd {
  /** The picture's name on the board. */
  name: string;
  /** A region's label, when the end is a region. */
  label?: string | null;
  /** The crop as a data URL, or null when the picture did not load. */
  crop: string | null;
}

export interface ReportClaim {
  kind: 'connection' | 'region';
  /** The relation or the label. */
  term: string;
  /** Connections only. */
  direction?: 'none' | 'forward' | 'reverse' | 'both';
  confidence?: string | null;
  note?: string;
  made?: ReportPerson | null;
  edited?: ReportPerson | null;
  ends: ReportEnd[];
  properties: Record<string, unknown>;
  replies: (ReportPerson & { text: string })[];
  /** A link back to the claim in the app. */
  link: string;
}

export interface Report {
  sheetName: string;
  boardName: string;
  /** Who made the report, and when. */
  by: string;
  at: string;
  link: string;
  claims: ReportClaim[];
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const e = escapeHtml;

/** Only these reach an attribute that loads something. */
const safeUrl = (url: string) =>
  /^(https?:|data:image\/(png|jpeg|webp);base64,)/.test(url) ? url : '';

const when = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : '';
};

const ARROW: Record<string, string> = {
  forward: '→',
  reverse: '←',
  both: '↔',
  none: '—',
};

function end(x: ReportEnd): string {
  const picture = x.crop
    ? `<img src="${e(safeUrl(x.crop))}" alt="${e(x.label ? `${x.label}, on ${x.name}` : x.name)}">`
    : '<div class="missing">picture not available</div>';
  return `<figure>${picture}<figcaption>${x.label ? `<b>${e(x.label)}</b><br>` : ''}${e(x.name)}</figcaption></figure>`;
}

function claim(c: ReportClaim, n: number): string {
  const facts: string[] = [];
  if (c.confidence) facts.push(`<dt>How sure</dt><dd>${e(c.confidence)}</dd>`);
  if (c.note) facts.push(`<dt>Why</dt><dd>${e(c.note)}</dd>`);
  for (const [k, v] of Object.entries(c.properties))
    facts.push(
      `<dt>${e(k)}</dt><dd>${e(Array.isArray(v) ? v.join(', ') : String(v))}</dd>`,
    );
  if (c.made)
    facts.push(
      `<dt>Added</dt><dd>${e(c.made.name)}, ${e(when(c.made.at))}</dd>`,
    );
  if (c.edited)
    facts.push(
      `<dt>Last changed</dt><dd>${e(c.edited.name)}, ${e(when(c.edited.at))}</dd>`,
    );
  const heading =
    c.kind === 'connection'
      ? `${n}. <span class="kind">Connection</span> ${e(c.term || 'unnamed')}`
      : `${n}. <span class="kind">Region</span> ${e(c.term || 'unlabelled')}`;
  const ends =
    c.kind === 'connection' && c.ends.length === 2
      ? `${end(c.ends[0] as ReportEnd)}<div class="arrow">${ARROW[c.direction ?? 'none']}</div>${end(c.ends[1] as ReportEnd)}`
      : c.ends.map(end).join('');
  const replies = c.replies.length
    ? `<h4>Discussion</h4><ol class="replies">${c.replies
        .map(
          (r) =>
            `<li><b>${e(r.name)}</b> <time>${e(when(r.at))}</time><p>${e(r.text)}</p></li>`,
        )
        .join('')}</ol>`
    : '';
  return `<section class="claim"><h3>${heading}</h3><div class="ends">${ends}</div>${
    facts.length ? `<dl>${facts.join('')}</dl>` : ''
  }${replies}<p class="link"><a href="${e(safeUrl(c.link))}">Open this claim</a></p></section>`;
}

export function buildReport(r: Report): string {
  const connections = r.claims.filter((c) => c.kind === 'connection');
  const regions = r.claims.filter((c) => c.kind === 'region');
  let n = 0;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(r.sheetName)} · ${e(r.boardName)}</title>
<style>
body{margin:0 auto;max-width:880px;padding:32px 20px;font:15px/1.5 system-ui,sans-serif;color:#1d1b18;background:#fbfaf7}
h1{margin:0 0 4px;font-size:26px}h2{margin:36px 0 12px;font-size:18px;border-bottom:1px solid #ddd8cf;padding-bottom:6px}
h3{margin:0 0 12px;font-size:16px}h4{margin:14px 0 6px;font-size:13px;color:#6b665e}
.meta{color:#6b665e;font-size:13px}.kind{color:#8a5a14;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.claim{margin:0 0 18px;padding:16px;border:1px solid #ddd8cf;border-radius:10px;background:#fff;break-inside:avoid}
.ends{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.arrow{font-size:22px;color:#2566a8}
figure{margin:0;max-width:260px}figure img{display:block;max-width:260px;max-height:220px;border-radius:6px;border:1px solid #ddd8cf}
figcaption{font-size:12px;color:#6b665e;margin-top:4px;overflow-wrap:anywhere}.missing{width:160px;height:110px;display:grid;place-items:center;background:#eee;color:#888;font-size:12px;border-radius:6px}
dl{display:grid;grid-template-columns:9em 1fr;gap:4px 12px;margin:14px 0 0;font-size:14px}dt{color:#6b665e}dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.replies{margin:0;padding-left:18px;font-size:14px}.replies p{margin:2px 0 8px;white-space:pre-wrap}time{color:#6b665e;font-size:12px}
.link{margin:12px 0 0;font-size:13px}a{color:#2566a8}
@media print{body{background:#fff}.claim{border-color:#bbb}}
</style></head><body>
<h1>${e(r.sheetName)}</h1>
<p class="meta">A sheet on the board ${e(r.boardName)}. ${connections.length} connection${connections.length === 1 ? '' : 's'}, ${regions.length} region${regions.length === 1 ? '' : 's'}.<br>
Made by ${e(r.by)}, ${e(when(r.at))}. <a href="${e(safeUrl(r.link))}">Open the sheet</a></p>
${connections.length ? `<h2>Connections</h2>${connections.map((c) => claim(c, ++n)).join('\n')}` : ''}
${regions.length ? `<h2>Regions</h2>${regions.map((c) => claim(c, ++n)).join('\n')}` : ''}
</body></html>
`;
}
