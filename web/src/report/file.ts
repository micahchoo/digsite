// A report as a file someone keeps (docs/roadmap.md "Report export"): the
// document shared/report/document.ts draws, in the app's own colours
// (tokens.css, inlined), with the pictures and, when the app has one built,
// the viewer bundle that turns it into the live sheet in a browser.
//
// The viewer is optional on purpose. Without it the file is still the whole
// report, which is the promise a citation needs; with it the reader gets the
// app's own canvas, Compare and web view.
import type { ReportData } from '@digsite/shared';
import { renderDocument } from '@digsite/shared/report/document';
import tokensCss from '../theme/tokens.css?raw';
import { type PictureSource, picturesFor } from './pictures.ts';
import { stillOf } from './still.ts';

/** Built by `vite.viewer.config.ts` into public/, so the app serves it. */
export const VIEWER_URL = '/report-viewer.js';

async function viewerBundle(): Promise<string | null> {
  try {
    const res = await fetch(VIEWER_URL);
    const type = res.headers.get('content-type') ?? '';
    return res.ok && type.includes('javascript') ? await res.text() : null;
  } catch {
    return null;
  }
}

export type FileProgress = (step: string) => void;

/** The whole file, as text. */
export async function reportHtml(
  data: ReportData,
  source: PictureSource,
  say: FileProgress = () => {},
): Promise<string> {
  const pictures = await picturesFor(data.images, source, (done, of) =>
    say(`Reading pictures, ${done} of ${of}…`),
  );
  say('Drawing the sheet…');
  const captions = new Map(data.images.map((img) => [img.id, img.name]));
  const still = data.scene
    ? await stillOf(data.scene.elements, pictures, captions)
    : null;
  const viewer = await viewerBundle();
  return renderDocument(data, { pictures, tokensCss, still, viewer });
}

/** A file name from the title: letters, digits, dots and dashes only. */
export function fileName(data: ReportData): string {
  const base = data.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'report'}-report.html`;
}

export function download(html: string, name: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
