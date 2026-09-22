// A click-to-edit name: Sheet.tsx's sidebar heading and Board.tsx's sheet
// list both rename a sheet through `PATCH /sheets/:id` (docs/phases/2-sheet.md
// section 6) and want the same control rather than two copies of it.
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
        data-testid={testId ?? 'rename-inline'}
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          font: 'inherit',
          cursor: 'text',
          textAlign: 'left',
          ...style,
        }}
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
