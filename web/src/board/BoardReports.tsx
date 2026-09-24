import type { ReportChanges, ReportClaim, ReportData } from '@digsite/shared';
// The board's kept reports, in the right column (CONTEXT.md "Kept report",
// "Published report"): each one to download again as it was kept, to check
// against the board now ("What changed"), to give a link to someone outside
// the group, or to remove. A kept report never changes; what changes is the
// board, and this says how.
import type { KeptReport } from '@digsite/shared/api';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { ApiError, api } from '../lib/api.ts';
import { plural } from '../lib/plural.ts';
import '../report/report.css';

/** Anything that kept a report says so, and every list refreshes. */
const CHANGED = 'digsite:reports-changed';
export function notifyReportsChanged(): void {
  window.dispatchEvent(new Event(CHANGED));
}

const SCOPE: Record<ReportData['scope']['kind'], string> = {
  sheet: 'a sheet',
  selection: 'a selection',
  board: 'the board',
  relation: 'a relation',
  path: 'a path',
};

const FIELD: Record<string, string> = {
  term: 'what it says',
  direction: 'its direction',
  confidence: 'how sure',
  note: 'why',
  properties: 'its properties',
  ends: 'what it rests on',
  dangling: 'whether it still holds',
  replies: 'the discussion',
};

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function claimName(c: ReportClaim): string {
  return c.kind === 'connection'
    ? c.term || 'an unnamed connection'
    : `region ${c.term || 'unlabelled'}`;
}

function Changes({ changes }: { changes: ReportChanges }) {
  const { added, removed, changed, same } = changes;
  if (!added.length && !removed.length && !changed.length)
    return (
      <p className="board-report-changes" data-testid="report-changes">
        Nothing has changed: all {plural(same, 'claim')} still say what they
        said.
      </p>
    );
  return (
    <div className="board-report-changes" data-testid="report-changes">
      <p>
        Since it was kept: {added.length} added, {removed.length} gone,{' '}
        {changed.length} changed, {same} the same.
      </p>
      <ul>
        {added.map((c) => (
          <li key={`a${c.key}`}>Added: {claimName(c)}</li>
        ))}
        {removed.map((c) => (
          <li key={`r${c.key}`}>Gone: {claimName(c)}</li>
        ))}
        {changed.map((c) => (
          <li key={`c${c.key}`}>
            {claimName(c.after)}:{' '}
            {c.fields.map((f) => FIELD[f] ?? f).join(', ')}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function BoardReports({
  boardId,
  make,
}: {
  boardId: string;
  /** Makes and downloads a report file (report/use-report.tsx). */
  make: (ask: () => Promise<ReportData>) => Promise<void>;
}) {
  const [reports, setReports] = useState<KeptReport[]>([]);
  const [changes, setChanges] = useState<Record<string, ReportChanges>>({});
  const [links, setLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setReports(
      (await api.listReports(boardId).catch(() => null))?.reports ?? [],
    );
  }, [boardId]);
  useEffect(() => {
    void refresh();
    window.addEventListener(CHANGED, refresh);
    return () => window.removeEventListener(CHANGED, refresh);
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  return (
    <section className="board-panel-section" data-testid="board-reports">
      <header className="board-panel-heading">
        <h2>
          Reports <span className="board-panel-count">{reports.length}</span>
        </h2>
      </header>
      {error && <div className="error">{error}</div>}
      {reports.length === 0 ? (
        <p className="board-empty-note">
          Keep a report from a sheet to cite it later and see what changes.
        </p>
      ) : (
        <ul className="board-report-list">
          {reports.map((r) => (
            <li
              key={r.id}
              className="board-report-row"
              data-testid="report-list-item"
            >
              <div className="board-report-copy">
                <span className="board-report-title">{r.title}</span>
                <span className="board-report-meta">
                  Of {SCOPE[r.scope.kind]} · {plural(r.claims, 'claim')} ·{' '}
                  {r.by}, {when(r.at)}
                  {r.link &&
                    ` · linked${r.link.expiresAt ? ` until ${when(r.link.expiresAt)}` : ''}`}
                </span>
              </div>
              <div className="board-report-actions">
                <button
                  type="button"
                  className="board-quiet-button"
                  data-testid={`report-download-${r.id}`}
                  title="Download it as it was kept"
                  onClick={() => void make(() => api.getReport(r.id))}
                >
                  Download
                </button>
                <a
                  className="board-quiet-button"
                  href={api.reportBundleUrl(r.id)}
                  data-testid={`report-bundle-${r.id}`}
                  title="The data in every format, the original pictures and their SHA-256 sums, as one zip"
                >
                  Evidence
                </a>
                <button
                  type="button"
                  className="board-quiet-button"
                  data-testid={`report-changes-${r.id}`}
                  aria-expanded={!!changes[r.id]}
                  onClick={() =>
                    void run(async () => {
                      if (changes[r.id]) {
                        const { [r.id]: _, ...rest } = changes;
                        setChanges(rest);
                        return;
                      }
                      const c = await api.reportChanges(r.id);
                      setChanges((prev) => ({ ...prev, [r.id]: c }));
                    })
                  }
                >
                  What changed
                </button>
              </div>
              <div className="board-report-link">
                {links[r.id] ? (
                  <>
                    <input
                      readOnly
                      value={links[r.id]}
                      aria-label="The link"
                      data-testid={`report-link-${r.id}`}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <button
                      type="button"
                      className="board-quiet-button"
                      onClick={() =>
                        void navigator.clipboard?.writeText(links[r.id] ?? '')
                      }
                    >
                      Copy
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="board-quiet-button"
                    data-testid={`report-publish-${r.id}`}
                    title="Anyone with the link can read this report and see its pictures, without an account, for 30 days"
                    onClick={() =>
                      void run(async () => {
                        const { token } = await api.publishReport(r.id, 30);
                        setLinks((prev) => ({
                          ...prev,
                          [r.id]: `${window.location.origin}/r/${token}`,
                        }));
                        await refresh();
                      })
                    }
                  >
                    {r.link ? 'Make a new link' : 'Make a link'}
                  </button>
                )}
                {r.link && (
                  <button
                    type="button"
                    className="board-quiet-button"
                    data-testid={`report-revoke-${r.id}`}
                    onClick={() =>
                      void run(async () => {
                        await api.revokeReportLink(r.id);
                        setLinks(({ [r.id]: _, ...rest }) => rest);
                        await refresh();
                      })
                    }
                  >
                    Stop the link
                  </button>
                )}

                <button
                  type="button"
                  className="board-icon-button board-icon-button--danger"
                  data-testid={`report-delete-${r.id}`}
                  aria-label={`Remove report ${r.title}`}
                  title="Remove report"
                  onClick={() =>
                    void run(async () => {
                      await api.deleteReport(r.id);
                      await refresh();
                    })
                  }
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
              {changes[r.id] && (
                <Changes changes={changes[r.id] as ReportChanges} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
