// Making a report from a page that has no progress line of its own (the
// board: its menu, its Terms, its path panel): ask the server, make the
// file, download it, and say each step where the person is looking.
import type { ReportData } from '@digsite/shared';
import { useCallback, useState } from 'react';
import { api } from '../lib/api.ts';
import { download, fileName, reportHtml } from './file.ts';
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
  return { working, make };
}

/** The report's progress, over the page. */
export function ReportWorking({ message }: { message: string | null }) {
  return message ? (
    <output className="report-working" aria-live="polite">
      {message}
    </output>
  ) : null;
}
