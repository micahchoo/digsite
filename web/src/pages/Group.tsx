import type { GetGroupResponse, Role } from '@digsite/shared/api';
// The group home (docs/phases/3-groups.md sections 2 and 5). Boards with
// stats, recent sheets, invitations, and members with role management and
// leave. Allowlist management moved to Board.tsx (section 3) — a private
// board's allowlist is a property of the board, not the group.
//
// Every control here is shown to every member; the server decides who may
// actually use it (../.claude/rules/access-one-function-per-intent.md: "the
// web must never decide access; it shows what the server allows and
// handles 403 with the reason"). A row's own error, not a global banner, is
// where that reason lands.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router';
import {
  ErrorState,
  type ErrorStateInfo,
  fromCaught,
} from '../components/ErrorState.tsx';
import { ApiError, api } from '../lib/api.ts';
import { useSession } from '../lib/auth.ts';
import { bytesLabel } from '../lib/bytes.ts';
import { isValidEmail } from '../lib/email.ts';
import { plural } from '../lib/plural.ts';
import type { ShellRoute } from '../shell/useShellData.ts';
import './group.css';
import { Icon } from '../components/Icon.tsx';

const ROLES: Role[] = ['owner', 'admin', 'member'];

function BoardImagePreview({
  boardId,
  imageCount,
}: {
  boardId: string;
  imageCount: number;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [unavailableIds, setUnavailableIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const visibleImageIds = imageIds.filter((id) => !unavailableIds.has(id));

  useEffect(() => {
    if (imageCount === 0) return;
    const node = host.current;
    if (!node) return;
    let cancelled = false;
    const load = () => {
      void api
        .listBoardImages(boardId, 'uploaded_at.desc', 0, 6)
        .then(({ images }) => {
          if (cancelled) return;
          setImageIds(
            images
              .filter((image) => !image.missing && image.status === 'ready')
              .slice(0, 3)
              .map((image) => image.id),
          );
        })
        .catch(() => {
          if (!cancelled) setUnavailable(true);
        })
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });
    };

    if (!('IntersectionObserver' in window)) {
      load();
      return () => {
        cancelled = true;
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      },
      { rootMargin: '240px' },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [boardId, imageCount]);

  return (
    <span
      className="group-board-preview"
      ref={host}
      aria-hidden="true"
      data-testid={`board-preview-${boardId}`}
    >
      {visibleImageIds.length ? (
        <span
          className={`group-board-preview-images group-board-preview-images--${visibleImageIds.length}`}
        >
          {visibleImageIds.map((id) => (
            <img
              key={id}
              src={api.previewUrl(id)}
              alt=""
              loading="lazy"
              onError={() =>
                setUnavailableIds((previous) => new Set(previous).add(id))
              }
            />
          ))}
        </span>
      ) : (
        <span className="group-board-preview-empty">
          {imageCount === 0
            ? 'No images yet'
            : unavailable || unavailableIds.size > 0
              ? 'Image previews unavailable'
              : loaded
                ? 'No image previews available'
                : 'Loading image previews'}
        </span>
      )}
    </span>
  );
}

export function Group() {
  const { id } = useParams<{ id: string }>();
  const groupId = id ?? '';
  const { groupName } = useOutletContext<ShellRoute>();
  const { data: session } = useSession();

  const [boards, setBoards] = useState<
    Awaited<ReturnType<typeof api.listBoards>>
  >([]);
  const [recentSheets, setRecentSheets] = useState<
    Awaited<ReturnType<typeof api.listRecentSheets>>
  >([]);
  const [members, setMembers] = useState<
    Awaited<ReturnType<typeof api.listMembers>>
  >([]);
  const [pending, setPending] = useState<
    Awaited<ReturnType<typeof api.listPendingInvitations>>
  >([]);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // docs/ux/audit.md #1: a nonexistent (or inaccessible) group used to show
  // a real error banner but still render every "create a board" / "invite"
  // form fully working-looking underneath it. Set only from the board list
  // fetch — the page's core content — never from an action the viewer
  // triggered themselves (createBoard/sendInvite keep using `error` above).
  const [pageError, setPageError] = useState<ErrorStateInfo | null>(null);

  const [boardName, setBoardName] = useState('');
  const [boardOpen, setBoardOpen] = useState(true);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [storage, setStorage] = useState<GetGroupResponse['storage'] | null>(
    null,
  );
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [leaveError, setLeaveError] = useState<string | null>(null);

  // Each list loads on its own: the boards must show even when an optional
  // list (recent sheets, invitations) fails, or the page reads as broken
  // while creation actually succeeded.
  const refresh = useCallback(async () => {
    const [b, m, s] = await Promise.allSettled([
      api.listBoards(groupId),
      api.listMembers(groupId),
      api.listRecentSheets(groupId),
    ]);
    if (b.status === 'fulfilled') setBoards(b.value);
    if (m.status === 'fulfilled') setMembers(m.value);
    setRecentSheets(s.status === 'fulfilled' ? s.value : []);
    // Optional: a server without the route shows no storage line.
    setStorage(
      (await api.getGroup(groupId).catch(() => null))?.storage ?? null,
    );
    const failed = [b, m].find((r) => r.status === 'rejected');
    setError(
      failed?.status === 'rejected'
        ? failed.reason instanceof ApiError
          ? failed.reason.reason
          : String(failed.reason)
        : null,
    );
    setPageError(
      b.status === 'rejected' ? fromCaught(b.reason, 'group') : null,
    );
    try {
      setPending(await api.listPendingInvitations(groupId));
      setPendingError(null);
    } catch (err) {
      setPending([]);
      setPendingError(err instanceof ApiError ? err.reason : String(err));
    }
  }, [groupId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createBoard(e: React.FormEvent) {
    e.preventDefault();
    if (!boardName.trim()) return;
    try {
      await api.createBoard(groupId, {
        name: boardName.trim(),
        open: boardOpen,
      });
      setBoardName('');
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  async function sendInvite() {
    setInviteError(null);
    setInviteCopied(false);
    // docs/ux/audit.md #7: validated before the request goes out at all —
    // a malformed address 500'd on the server with no way to fix it.
    const trimmed = inviteEmail.trim();
    if (trimmed && !isValidEmail(trimmed)) {
      setInviteError(`"${trimmed}" doesn't look like an email address.`);
      return;
    }
    try {
      // Blank omits the key entirely — sending `email: ''` is the other
      // half of the same server 500, queued for the server agent (see this
      // file's own report). A link-only invite has no email at all.
      const { url } = await api.invite(
        groupId,
        trimmed ? { email: trimmed } : {},
      );
      setInviteUrl(url);
      setInviteEmail('');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status >= 500) {
        // The real server's own 500s here (empty email, a repeat email) are
        // queued for the server agent — this is the client's half: never
        // show the raw "Internal Server Error" text.
        setInviteError('Something went wrong sending the invite. Try again.');
      } else {
        setInviteError(err instanceof ApiError ? err.reason : String(err));
      }
    }
  }

  async function copyInviteUrl() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
    } catch {
      // clipboard access denied; the URL is still shown to copy by hand
    }
  }

  async function revokeInvitation(invitationId: string) {
    try {
      await api.revokeInvitation(invitationId);
      await refresh();
    } catch (err) {
      setPendingError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  async function changeRole(userId: string, role: Role) {
    setRowError((prev) => ({ ...prev, [userId]: '' }));
    try {
      await api.updateMemberRole(groupId, userId, { role });
      await refresh();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [userId]: err instanceof ApiError ? err.reason : String(err),
      }));
    }
  }

  async function removeMember(userId: string) {
    setRowError((prev) => ({ ...prev, [userId]: '' }));
    try {
      await api.removeMember(groupId, userId);
      await refresh();
    } catch (err) {
      setRowError((prev) => ({
        ...prev,
        [userId]: err instanceof ApiError ? err.reason : String(err),
      }));
    }
  }

  async function leaveGroup() {
    setLeaveError(null);
    try {
      await api.leaveGroup(groupId);
      await refresh();
    } catch (err) {
      setLeaveError(err instanceof ApiError ? err.reason : String(err));
    }
  }

  if (pageError) return <ErrorState info={pageError} />;

  return (
    <div className="page group-home">
      <header className="group-heading">
        <div>
          <div className="group-eyebrow">Image workspace</div>
          <h1>{groupName ?? 'Group'}</h1>
          <p className="group-heading-meta">
            {plural(boards.length, 'board')} <span aria-hidden="true">·</span>{' '}
            {plural(members.length, 'member')}
            {storage && (
              <>
                {' '}
                <span aria-hidden="true">·</span>{' '}
                <span data-testid="group-storage">
                  {storage.quotaBytes === null
                    ? `${bytesLabel(storage.usedBytes)} stored`
                    : `${bytesLabel(storage.usedBytes)} of ${bytesLabel(storage.quotaBytes)} stored`}
                </span>
              </>
            )}
          </p>
          {storage?.quotaBytes ? (
            <StorageBar used={storage.usedBytes} quota={storage.quotaBytes} />
          ) : null}
        </div>
        <a className="group-create-shortcut" href="#group-create-board">
          <span aria-hidden="true">＋</span> Create a board
        </a>
      </header>
      {error && <div className="error group-page-error">{error}</div>}

      <div className="group-layout">
        <main className="group-main">
          <section
            className="group-section"
            aria-labelledby="group-boards-heading"
          >
            <div className="group-section-heading">
              <div>
                <h2 id="group-boards-heading">Boards</h2>
                <p>Collections of images for your group to explore.</p>
              </div>
              <span className="group-count">{boards.length}</span>
            </div>
            {boards.length === 0 ? (
              <div className="group-empty">
                <h3>Under construction.</h3>
                <p>This group hasn’t started a board yet.</p>
                <a href="#group-create-board">Create the first board</a>
              </div>
            ) : (
              <ul className="group-board-list" data-testid="board-list">
                {boards.map((b) => (
                  <li className="group-board-card" key={b.id}>
                    <Link className="group-board-link" to={`/b/${b.id}`}>
                      <BoardImagePreview
                        boardId={b.id}
                        imageCount={b.imageCount}
                      />
                      <span className="group-board-details">
                        <span className="group-board-copy">
                          <span className="group-board-title">{b.name}</span>
                          <span className="group-board-meta">
                            {plural(b.imageCount, 'image')}{' '}
                            <span aria-hidden="true">·</span>{' '}
                            {plural(b.sheetCount, 'sheet')}
                          </span>
                        </span>
                        <span
                          className={
                            b.open
                              ? 'group-access group-access--open'
                              : 'group-access'
                          }
                        >
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 16 16"
                            fill="none"
                          >
                            {b.open ? (
                              <>
                                <circle cx="8" cy="8" r="5.25" />
                                <path d="M5.7 8h4.6" />
                              </>
                            ) : (
                              <>
                                <rect
                                  x="3.2"
                                  y="6.6"
                                  width="9.6"
                                  height="7"
                                  rx="1.5"
                                />
                                <path d="M5.4 6.6V5a2.6 2.6 0 0 1 5.2 0v1.6" />
                              </>
                            )}
                          </svg>
                          {b.open ? 'Open' : 'Private'}
                        </span>
                        <span className="group-board-activity">
                          {b.lastActivity
                            ? `Active ${new Date(b.lastActivity).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                            : 'No activity yet'}
                        </span>
                        <span className="group-board-arrow" aria-hidden="true">
                          <svg
                            aria-hidden="true"
                            viewBox="0 0 16 16"
                            fill="none"
                          >
                            <path d="M4 12 12 4M5 4h7v7" />
                          </svg>
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            className="group-section group-recent"
            aria-labelledby="group-recent-heading"
          >
            <div className="group-section-heading">
              <div>
                <h2 id="group-recent-heading">Recent sheets</h2>
                <p>Shared investigations, from newest activity.</p>
              </div>
            </div>
            {recentSheets.length === 0 ? (
              <p className="group-quiet-empty">No recent sheets yet.</p>
            ) : (
              <ul className="group-recent-list" data-testid="recent-sheets">
                {recentSheets.map((s) => (
                  <li key={s.id}>
                    <Link to={`/s/${s.id}`}>
                      <span className="group-sheet-glyph" aria-hidden="true">
                        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
                          <path d="M5 3.5h7l3 3v10H5z" />
                          <path d="M12 3.5v3h3M7.5 10h5M7.5 13h5" />
                        </svg>
                      </span>
                      <span className="group-recent-copy">
                        <span className="group-recent-title">{s.name}</span>
                        <span className="group-recent-board">
                          in {s.boardName}
                        </span>
                      </span>
                      {s.savedAt && (
                        <time
                          className="group-recent-time"
                          dateTime={s.savedAt}
                        >
                          {new Date(s.savedAt).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </time>
                      )}
                      <Icon
                        name="arrowUpRight"
                        size={16}
                        className="group-board-arrow"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </main>

        <aside className="group-tools" aria-label="Group tools">
          <section className="group-panel" id="group-create-board">
            <div className="group-panel-heading">
              <h2>Create a board</h2>
              <p>Give a collection its own place to grow.</p>
            </div>
            <form onSubmit={(e) => void createBoard(e)}>
              <label className="group-field-label" htmlFor="group-board-name">
                Board name
              </label>
              <div className="group-create-row">
                <input
                  id="group-board-name"
                  data-testid="board-name"
                  placeholder="e.g. Field notes"
                  value={boardName}
                  onChange={(e) => setBoardName(e.target.value)}
                />
                <button className="group-primary-action" type="submit">
                  Create
                </button>
              </div>
              <fieldset className="group-visibility">
                <legend>Who can see it?</legend>
                <label>
                  <input
                    type="radio"
                    name="board-open"
                    checked={boardOpen}
                    onChange={() => setBoardOpen(true)}
                  />
                  <span>
                    <b>Open</b>
                    <small>Anyone in this group</small>
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="board-open"
                    checked={!boardOpen}
                    onChange={() => setBoardOpen(false)}
                  />
                  <span>
                    <b>Private</b>
                    <small>Only people on its list</small>
                  </span>
                </label>
              </fieldset>
            </form>
          </section>

          <section className="group-panel group-invite-panel">
            <div className="group-panel-heading">
              <h2>Invite people</h2>
              <p>Bring another member into the workspace.</p>
            </div>
            <label className="group-field-label" htmlFor="group-invite-email">
              Email address
            </label>
            <div className="group-create-row">
              <input
                id="group-invite-email"
                data-testid="invite-email"
                type="email"
                placeholder="name@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
              <button
                type="button"
                data-testid="invite-send"
                onClick={() => void sendInvite()}
              >
                Invite
              </button>
            </div>
            {inviteError && (
              <div className="error group-inline-error">{inviteError}</div>
            )}
            {inviteUrl && (
              <div className="group-invite-result">
                <label className="group-field-label" htmlFor="group-invite-url">
                  Invitation link
                </label>
                <div className="group-create-row">
                  <input
                    id="group-invite-url"
                    data-testid="invite-url"
                    readOnly
                    value={inviteUrl}
                  />
                  <button
                    type="button"
                    data-testid="invite-copy"
                    onClick={() => void copyInviteUrl()}
                  >
                    {inviteCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            )}

            <div className="group-pending">
              <h3>Pending invitations</h3>
              {pendingError && (
                <div className="error group-inline-error">{pendingError}</div>
              )}
              {!pendingError && pending.length === 0 && (
                <p className="group-quiet-empty">No invitations waiting.</p>
              )}
              <ul data-testid="pending-invitations">
                {pending.map((inv) => (
                  <li key={inv.id}>
                    <span>{inv.email ?? 'Link invitation'}</span>
                    <button
                      type="button"
                      data-testid={`revoke-${inv.id}`}
                      onClick={() => void revokeInvitation(inv.id)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="group-panel group-members-panel">
            <div className="group-panel-heading">
              <h2>Members</h2>
              <p>{plural(members.length, 'person')} in this group.</p>
            </div>
            <div className="group-member-list" data-testid="member-list">
              {members.map((m) => (
                <div
                  className="group-member-row"
                  key={m.userId}
                  data-testid={`member-row-${m.userId}`}
                >
                  <span className="group-member-avatar" aria-hidden="true">
                    {m.name.trim().slice(0, 1).toUpperCase() || '?'}
                  </span>
                  <span className="group-member-identity">
                    <span className="group-member-name">{m.name}</span>
                    <span className="group-member-email">{m.email}</span>
                    <span
                      className="error"
                      data-testid={`member-error-${m.userId}`}
                    >
                      {rowError[m.userId] ?? ''}
                    </span>
                  </span>
                  <select
                    aria-label={`${m.name} role`}
                    data-testid={`role-select-${m.userId}`}
                    value={m.role}
                    onChange={(e) =>
                      void changeRole(m.userId, e.target.value as Role)
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                  <button
                    className="group-member-remove"
                    type="button"
                    data-testid={`remove-${m.userId}`}
                    onClick={() => void removeMember(m.userId)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="group-account-row">
              <button
                className="group-leave-action"
                type="button"
                data-testid="leave-group"
                onClick={() => void leaveGroup()}
              >
                Leave group
              </button>
              <span className="muted">
                {session?.user.email
                  ? `Signed in as ${session.user.email}`
                  : ''}
              </span>
            </div>
            {leaveError && (
              <div
                className="error group-inline-error"
                data-testid="leave-error"
              >
                {leaveError}
              </div>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

/** How full a group's storage is. Past nine tenths it warns, because the
 * next upload may be refused (board/upload.ts stops the queue on a full
 * group). */
function StorageBar({ used, quota }: { used: number; quota: number }) {
  const share = Math.min(1, used / quota);
  const nearlyFull = share >= 0.9;
  return (
    <div className="group-storage">
      <div
        className="group-storage-bar"
        role="meter"
        aria-label="Storage used"
        aria-valuemin={0}
        aria-valuemax={quota}
        aria-valuenow={used}
        data-full={nearlyFull}
      >
        <span style={{ width: `${(share * 100).toFixed(1)}%` }} />
      </div>
      {nearlyFull && (
        <p className="group-storage-note" data-testid="group-storage-warning">
          {share >= 1
            ? 'Storage is full: new pictures will be refused.'
            : 'Storage is nearly full.'}{' '}
          Delete pictures the group no longer needs, or ask whoever runs this
          server for more space.
        </p>
      )}
    </div>
  );
}
