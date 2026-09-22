// A confirmation panel for a destructive action whose consequences the
// caller has already fetched (board/sheet footprint counts —
// docs/phases/3-groups.md section 4). Not a modal dialog — no UI library
// (web/README.md) — an inline card next to whatever triggered it.
interface Props {
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  testId: string;
}

export function Confirm({
  message,
  confirmLabel = 'delete',
  busy,
  error,
  onConfirm,
  onCancel,
  testId,
}: Props) {
  return (
    <div
      className="card"
      data-testid={testId}
      style={{ borderColor: '#e03131', background: '#fff5f5' }}
    >
      <div>{message}</div>
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ marginTop: 6 }}>
        <button
          type="button"
          data-testid={`${testId}-confirm`}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? 'working…' : confirmLabel}
        </button>
        <button
          type="button"
          data-testid={`${testId}-cancel`}
          disabled={busy}
          onClick={onCancel}
        >
          cancel
        </button>
      </div>
    </div>
  );
}
