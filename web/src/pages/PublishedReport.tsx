// A published report (CONTEXT.md "Published report"): what someone outside
// the group sees at /r/<token>, with no account. It is the same document a
// report file is (shared/report/document.ts) with the same viewer, its
// pictures served by the link, shown in a sandboxed frame so nothing in it
// can reach this app's session. "Download" makes the file, pictures inside,
// to keep after the link ends.
import type { ReportData } from '@digsite/shared';
import { renderDocument } from '@digsite/shared/report/document';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { ApiError, api } from '../lib/api.ts';
import {
  download,
  fileName,
  reportHtml,
  viewerBundle,
} from '../report/file.ts';
import tokensCss from '../theme/tokens.css?raw';
import '../report/report.css';

type State =
  | { kind: 'loading' }
  | { kind: 'gone' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; data: ReportData; html: string };

export function PublishedReport() {
  const { token = '' } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.publishedReport(token);
        const pictures = Object.fromEntries(
          data.images
            .filter((img) => !img.missing)
            .map((img) => [img.id, api.publishedImageUrl(token, img.id)]),
        );
        const html = renderDocument(data, {
          pictures,
          tokensCss,
          viewer: await viewerBundle(),
        });
        if (!cancelled) setState({ kind: 'ready', data, html });
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404)
          setState({ kind: 'gone' });
        else
          setState({
            kind: 'failed',
            message: err instanceof Error ? err.message : 'unknown error',
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function keep(data: ReportData) {
    try {
      const html = await reportHtml(
        data,
        async (imageId) => {
          const res = await fetch(api.publishedImageUrl(token, imageId));
          return res.ok ? res.blob() : null;
        },
        setWorking,
      );
      download(html, fileName(data));
      setWorking(null);
    } catch (err) {
      setWorking(
        `Could not make the file: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  if (state.kind === 'loading')
    return <div className="published-note">Opening the report…</div>;
  if (state.kind === 'gone')
    return (
      <div className="published-note" data-testid="published-gone">
        <h1>This link does not open a report</h1>
        <p>
          It has ended, or whoever made it stopped it. Ask them for a new one.
        </p>
      </div>
    );
  if (state.kind === 'failed')
    return (
      <div className="published-note" role="alert">
        <h1>The report could not be opened</h1>
        <p>{state.message}</p>
      </div>
    );
  return (
    <div className="published-page" data-testid="published-report">
      <header className="published-bar">
        <span>
          <b>digsite</b> · a report shared with you
        </span>
        <button
          type="button"
          data-testid="published-download"
          onClick={() => void keep(state.data)}
        >
          Download to keep
        </button>
      </header>
      <iframe
        title={state.data.title}
        srcDoc={state.html}
        // Scripts for the viewer; nothing from this origin, so the page
        // cannot touch the app's session. Links leave in a new tab.
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />
      {working && (
        <output className="report-working" aria-live="polite">
          {working}
        </output>
      )}
    </div>
  );
}
