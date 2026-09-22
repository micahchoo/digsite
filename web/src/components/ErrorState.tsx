// docs/ux/audit.md #1 (top of the "Top 15" list): a board, sheet or group
// the viewer cannot see, or that does not exist, used to hang on bare
// "loading…" forever — `getBoard().catch()` was simply missing. Every
// data-loading page now catches its fetch and renders THIS component
// instead of leaving `loading…` up: a 403 (with the server's own reason,
// and a friendly "ask <creator>" line where a creator name is known), a
// 404, a 500 (with the `X-Request-Id` the server attaches, if the response
// carried one — `lib/api.ts#ApiError.requestId`), or a network failure.
//
// `describeError` is the pure half (status/resource/reason/requestId in,
// heading/body/detail out) — tested without React in
// `web/test/error-state.test.ts`. `fromCaught` turns whatever a `catch`
// block actually has (an `ApiError`, or a raw `fetch` rejection when the
// server never answered at all) into the same shape, so every call site
// looks the same: `.catch((err) => setError(fromCaught(err)))`.
import { Link } from 'react-router';
import { ApiError } from '../lib/api.ts';

export type ErrorStatus = 403 | 404 | 500 | 'network' | number;

export interface ErrorStateInfo {
  status: ErrorStatus;
  /** The server's own `{reason}` (or, for an uncaught 500, `{error}`) —
   * shown verbatim when present, per docs/ux/audit.md #1's "the server's
   * `{reason}` is shown if it gives one". */
  reason?: string | null;
  requestId?: string | null;
  /** What the page was loading — 'board', 'sheet', 'group', 'invitation'.
   * Feeds the headline; defaults to 'page' so a call site that has no
   * better word still reads as a sentence. */
  resource?: string;
  /** Known only where the page already has it (nowhere today — a 403
   * response carries no creator name yet, a gap noted for the server side).
   * Falls back to a generic "its owner" rather than leaving a blank. */
  creatorName?: string | null;
}

export interface ErrorContent {
  heading: string;
  body: string;
  /** A second, muted line — the server's raw reason (if it added anything
   * the heading didn't already say) and/or the request id. Empty when
   * neither applies. */
  detail: string | null;
}

/** Pure: every case `ErrorState` can render, spelled out once so a test can
 * check the copy without mounting anything. */
export function describeError(info: ErrorStateInfo): ErrorContent {
  const resource = info.resource ?? 'page';
  const reason = info.reason?.trim() || null;

  if (info.status === 403) {
    const who = info.creatorName?.trim() || `this ${resource}'s owner`;
    const heading = `You're not on this ${resource}'s list.`;
    const body = `Ask ${who} to add you.`;
    return {
      heading,
      body,
      detail: reason ? `Reason: ${reason}` : null,
    };
  }

  if (info.status === 404) {
    return {
      heading: `This ${resource} doesn't exist.`,
      body: 'It may have been deleted, or the link may be wrong.',
      detail: reason && reason.toLowerCase() !== 'not found' ? reason : null,
    };
  }

  if (info.status === 'network') {
    return {
      heading: "Couldn't reach the server.",
      body: 'Check your connection and try again.',
      detail: reason,
    };
  }

  // 500, or any other unexpected status.
  const detailParts: string[] = [];
  if (reason) detailParts.push(reason);
  if (info.requestId) detailParts.push(`Reference: ${info.requestId}`);
  return {
    heading: `Something went wrong loading this ${resource}.`,
    body: 'Try reloading the page. If it keeps happening, report it with the reference below.',
    detail: detailParts.length ? detailParts.join(' — ') : null,
  };
}

/** Turns whatever a `catch` actually caught into `ErrorStateInfo` — an
 * `ApiError` (the normal case, every `lib/api.ts` call) or a raw `fetch`
 * rejection (the server never answered at all: offline, DNS, connection
 * refused — `TypeError: Failed to fetch` and similar, browser-dependent,
 * so this treats anything that ISN'T an ApiError as 'network' rather than
 * pattern-matching a message string). */
export function fromCaught(
  err: unknown,
  resource?: string,
  creatorName?: string | null,
): ErrorStateInfo {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      reason: err.reason,
      requestId: err.requestId,
      resource,
      creatorName,
    };
  }
  return { status: 'network', resource, creatorName };
}

export function ErrorState({ info }: { info: ErrorStateInfo }) {
  const { heading, body, detail } = describeError(info);
  return (
    <div className="page error-state" data-testid="error-state">
      <h2>{heading}</h2>
      <p>{body}</p>
      {detail && <p className="muted">{detail}</p>}
      <p>
        <Link to="/groups">back to your groups</Link>
      </p>
    </div>
  );
}
