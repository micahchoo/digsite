// A kept report's evidence (docs/roadmap.md "Report export", R5): one zip
// holding the report's data, in every format other tools read
// (shared/report/formats.ts), and the ORIGINAL of every picture it shows,
// with a SHA256SUMS file a reader checks with `sha256sum -c SHA256SUMS`.
// The report names each picture by the same hash (urn:sha256:...), so the
// bundle proves the pictures are the ones the claims were made on.
//
// The readable report is the .html file made beside it; this is what backs
// it up. Entries are stored whole (boards/zip.ts).
import { type ReportData, reportFiles } from '@digsite/shared';
import { scopeSentence } from '@digsite/shared/report/document';
import { originalKey } from '../boards/paths.ts';
import { ZipWriter, uniqueNames } from '../boards/zip.ts';
import { storageFromEnv } from '../storage/index.ts';

const sha256 = (bytes: Uint8Array) =>
  new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

const text = (s: string) => new TextEncoder().encode(s);

export async function writeBundle(
  data: ReportData,
  boardId: string,
  write: (chunk: Uint8Array) => void,
): Promise<void> {
  const zip = new ZipWriter(write);
  const sums: string[] = [];
  const add = (name: string, bytes: Uint8Array) => {
    zip.add(name, bytes);
    sums.push(`${sha256(bytes)}  ${name}`);
  };

  const storage = storageFromEnv();
  const shown = data.images.filter((img) => !img.missing);
  const names = uniqueNames(shown.map((img) => img.name));
  const gone: string[] = data.images
    .filter((img) => img.missing)
    .map((img) => `${img.name} (removed from the board)`);
  const differ: string[] = [];
  const pictures: [string, Uint8Array][] = [];
  for (const [i, img] of shown.entries()) {
    const bytes = await storage.get(originalKey(boardId, img.sha256));
    if (!bytes) {
      gone.push(`${img.name} (no original stored)`);
      continue;
    }
    const got = sha256(bytes);
    if (got !== img.sha256)
      differ.push(`${img.name}: cited ${img.sha256}, stored ${got}`);
    pictures.push([`pictures/${names[i]}`, bytes]);
  }

  const files = reportFiles(data);
  const readme = [
    data.title,
    '',
    scopeSentence(data),
    `Made by ${data.by}, ${data.at}.`,
    data.id ? `Kept by digsite as report ${data.id}.` : '',
    '',
    'What is here',
    '  report.json         the report, format digsite-report/1',
    '  annotations.jsonld  every claim as a W3C Web Annotation',
    '  claims.csv          every claim, one row each',
    '  graph.graphml       pictures and connections, for Gephi or yEd',
    '  pictures/           the original of every picture the report shows',
    '  SHA256SUMS          the SHA-256 of every file above',
    '',
    'To check nothing was changed:  sha256sum -c SHA256SUMS',
    'A picture is cited by its SHA-256 (urn:sha256:... in annotations.jsonld,',
    'sha256 in report.json), the same hash SHA256SUMS lists for its file.',
    ...(gone.length ? ['', 'Not included:', ...gone.map((g) => `  ${g}`)] : []),
    ...(differ.length
      ? [
          '',
          'Stored bytes differ from the cited hash:',
          ...differ.map((d) => `  ${d}`),
        ]
      : []),
    '',
  ].join('\n');

  add('README.txt', text(readme));
  for (const [name, body] of Object.entries(files)) add(name, text(body));
  for (const [name, bytes] of pictures) add(name, bytes);
  zip.add('SHA256SUMS', text(`${sums.join('\n')}\n`));
  zip.finish();
}
