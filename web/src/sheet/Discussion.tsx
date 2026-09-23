// What people say about one claim (CONTEXT.md "Reply"): oldest first, each
// with who and when, and a box to answer. The replies live on the claim's
// own sheet, so another sheet's claim is discussed where it was made.
// Polled while open; a reply is sent at once and shown when it is stored.
import type { ClaimReply } from '@digsite/shared/api';
import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../components/Icon.tsx';
import { api } from '../lib/api.ts';
import { ago } from '../lib/when.ts';

const POLL_MS = 5000;
const MAX_CHARS = 2000;

interface Props {
  /** The sheet the claim belongs to, which may be another sheet. */
  sheetId: string;
  elementId: string;
  /** The signed-in person, who may remove their own replies. */
  userId: string | null;
}

export function Discussion({ sheetId, elementId, userId }: Props) {
  const [replies, setReplies] = useState<ClaimReply[] | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { replies: all } = await api.getReplies(sheetId);
      setReplies(all.filter((r) => r.elementId === elementId));
    } catch {
      // Keep what is shown; the next poll tries again.
    }
  }, [sheetId, elementId]);

  useEffect(() => {
    setReplies(null);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError('');
    try {
      const reply = await api.addReply(sheetId, elementId, text);
      setReplies((current) => [...(current ?? []), reply]);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The reply was not sent.');
    } finally {
      setSending(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteReply(sheetId, id);
      setReplies((current) => (current ?? []).filter((r) => r.id !== id));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'The reply was not removed.',
      );
    }
  }

  return (
    <section
      className="claim-section claim-discussion"
      data-testid="discussion"
    >
      <h3>
        Discussion
        {replies && replies.length > 0 && (
          <span className="claim-count">{replies.length}</span>
        )}
      </h3>
      {replies && replies.length > 0 && (
        <ol className="claim-replies">
          {replies.map((reply) => (
            <li key={reply.id} data-testid="discussion-reply">
              <div className="claim-reply-head">
                <b>{reply.by.name}</b>
                <time dateTime={reply.at}>{ago(reply.at)}</time>
                {reply.by.id === userId && (
                  <button
                    type="button"
                    className="claim-icon-button"
                    aria-label="Remove your reply"
                    title="Remove"
                    onClick={() => void remove(reply.id)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                )}
              </div>
              <p>{reply.text}</p>
            </li>
          ))}
        </ol>
      )}
      {replies && replies.length === 0 && (
        <p className="claim-hint">
          Nobody has said anything about this yet. Ask a question, add a source,
          or say why you doubt it.
        </p>
      )}
      <form
        className="claim-reply-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Reply"
          data-testid="discussion-input"
          placeholder="Reply…"
          rows={2}
          maxLength={MAX_CHARS}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button
          type="submit"
          data-testid="discussion-send"
          disabled={!draft.trim() || sending}
          title="Send (Ctrl+Enter)"
        >
          {sending ? 'Sending…' : 'Reply'}
        </button>
      </form>
      {error && (
        <p className="claim-hint" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
