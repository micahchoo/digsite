// Making a report from a page that has no progress line of its own (the
// board: its menu, its Terms, its path panel): ask the server, make the
// file, download it, and say each step where the person is looking. And
// the way back in: a report file made into a new sheet (import.ts).
import type { ReportData } from '@digsite/shared';
import { useCallback, useState } from 'react';
import { api } from '../lib/api.ts';
import { notifySheetsChanged } from '../lib/sheetEvents.ts';
import { download, fileName, reportHtml } from './file.ts';
import { type ImportPlan, importPlan, readReportFile } from './import.ts';
import { previewSource } from './pictures.ts';
import './report.css';

export function useReport() {
  const [working, setWorking] = useState<string | null>(null);
  const make = useCallback(async (ask: () => Promise<ReportData>) => {
    setWorking('Gathering the report…');
    try {
      const data = await ask();
      const html = await reportHtml(
        data,
        previewSource(api.previewUrl),
        setWorking,
      );
      download(html, fileName(data));
      setWorking(null);
    } catch (err) {
      setWorking(
        `Could not make the report: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
      window.setTimeout(() => setWorking(null), 6000);
    }
  }, []);
  /** A report file's claims, as a new sheet on `boardId`: its pictures
   * found by hash, the sheet made where the report had them, then opened
   * with the plan, which the sheet carries out (Sheet.tsx). */
  const bringIn = useCallback(
    async (
      boardId: string,
      file: File,
      open: (sheetId: string, plan: ImportPlan) => void,
    ) => {
      const fail = (message: string) => {
        setWorking(message);
        window.setTimeout(() => setWorking(null), 8000);
      };
      setWorking('Reading the report…');
      try {
        const data = readReportFile(await file.text());
        if (!data) return fail('That file holds no digsite report.');
        const hashes = [...new Set(data.images.map((img) => img.sha256))];
        const held: { id: string; sha256: string }[] = [];
        for (let i = 0; i < hashes.length; i += 400)
          held.push(
            ...(await api.imagesBySha256(boardId, hashes.slice(i, i + 400)))
              .images,
          );
        const plan = importPlan(data, held);
        if (!plan.claims.length)
          return fail(
            'None of this report’s claims can land here: their pictures are not on this board.',
          );
        const { id } = await api.createSheet(boardId, {
          name: `${data.title} (imported)`,
          imageIds: plan.imageIds,
          positions: plan.positions,
        });
        notifySheetsChanged();
        setWorking(null);
        open(id, plan);
      } catch (err) {
        fail(
          `Could not import the report: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    },
    [],
  );
  return { working, make, bringIn };
}

/** The report's progress, over the page. */
export function ReportWorking({ message }: { message: string | null }) {
  return message ? (
    <output className="report-working" aria-live="polite">
      {message}
    </output>
  ) : null;
}
