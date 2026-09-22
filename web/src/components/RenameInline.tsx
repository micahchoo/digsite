// A click-to-edit name: Sheet.tsx's sidebar heading and Board.tsx's sheet
// list both rename a sheet through `PATCH /sheets/:id` (docs/phases/2-sheet.md
// section 6) and want the same control rather than two copies of it.
//
// docs/ux/audit.md #10: this used to render as plain inline styles —
// `background: none, border: none` — so it read as static bold text, with
// nothing hinting it was click-to-edit until the pointer happened to be a
// text caret over it. `.rename-inline` (style.css) adds a hover/focus
// pencil and a dotted underline; the control itself was already a real
// `<button>`, so Tab reaches it and Enter/Space already activate it
// (native button behaviour) — Escape-to-cancel was already wired on the
// input below. #12's "keyboard reachable" is this: nothing to add beyond
// making the affordance visible.
import { useEffect, useRef, useState } from 'react';

interface Props {
  name: string;
  onRename: (name: string) => Promise<void> | void;
  testId?: string;
  style?: React.CSSProperties;
}

export function RenameInline({ name, onRename, testId, style }: Props) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (value.trim() && value !== name) void onRename(value);
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="rename-inline"
        data-testid={testId ?? 'rename-inline'}
        aria-label={`Rename "${name}"`}
        title="Click to rename"
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
        style={style}
      >
        {name}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      data-testid={testId ? `${testId}-input` : 'rename-inline-input'}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
      style={style}
    />
  );
}
