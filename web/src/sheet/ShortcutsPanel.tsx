// The `?` panel: every key the sheet answers, from `shortcuts.ts`. A native
// modal `<dialog>`, so focus is held inside it and Escape closes it without
// our own trap.
import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon.tsx';
import { SHORTCUT_GROUPS } from './shortcuts.ts';

interface Props {
  onClose: () => void;
}

export function ShortcutsPanel({ onClose }: Props) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="sheet-shortcuts"
      data-testid="shortcuts-panel"
      aria-labelledby="sheet-shortcuts-title"
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself.
        if (e.target === e.currentTarget) ref.current?.close();
      }}
      onKeyDown={(e) => {
        if (e.key === '?') ref.current?.close();
      }}
    >
      <header className="sheet-shortcuts-head">
        <h2 id="sheet-shortcuts-title">Keyboard</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close"
          onClick={() => ref.current?.close()}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <div className="sheet-shortcuts-groups">
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.shortcuts.map((s) => (
                <div key={s.does} className="sheet-shortcuts-row">
                  <dt>
                    {s.keys.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </dt>
                  <dd>{s.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}
