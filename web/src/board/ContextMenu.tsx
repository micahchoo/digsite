// docs/ux/design.md §5.2 "Board Actions menu / right-click": grouped
// exactly as image-graph's `menu()` groups them — sections separated by a
// divider only when BOTH the previous and the next group actually have an
// item, never a leading or trailing one. Reachable identically from the
// `⋯` "Actions" button, a right-click on the canvas, and (design's own
// "one action, three surfaces" — image-graph's `view.ts#menu`). The sheet
// opens the same menu (sheet/sheet-menu.ts builds its sections).
//
// A menu a person opened from the keyboard must work from the keyboard:
// focus lands on the first item, arrows move, Escape and Tab close and hand
// focus back to where it was.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './context-menu.css';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown as a `title` attribute when disabled — never "coming soon"
   * (design.md §6/keep-writing conventions: state the reason or say
   * nothing). */
  disabledReason?: string;
  testId?: string;
  /** The key that does the same thing, shown at the right. */
  keys?: string;
  /** Removes something: drawn in the danger colour. */
  danger?: boolean;
  /** One of a set of choices: a radio item, checked or not. */
  checked?: boolean;
}
export type MenuSection = MenuItem[];

interface Props {
  x: number;
  y: number;
  sections: MenuSection[];
  onClose: () => void;
  testId?: string;
  /** Names the menu for a screen reader. */
  label?: string;
}

/** Only inserts a separator between two sections that both have items —
 * image-graph's own `section()` rule, ported. */
function withSeparators(sections: MenuSection[]): MenuSection[] {
  return sections.filter((s) => s.length > 0);
}

const WIDTH = 240;
const MARGIN = 8;

export function ContextMenu({
  x,
  y,
  sections,
  onClose,
  testId = 'board-context-menu',
  label = 'Actions',
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(y);
  // A parent passes a new `onClose` every render; held here so the effect
  // below runs once per open, and its cleanup (which hands focus back)
  // runs only when the menu really closes.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const onClose = () => onCloseRef.current();
    const previous = document.activeElement as HTMLElement | null;
    function onDocPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' || e.key === 'Tab') {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      // Back where the person was, unless they have moved on.
      if (
        previous?.isConnected &&
        (document.activeElement === document.body ||
          ref.current?.contains(document.activeElement))
      )
        previous.focus({ preventScroll: true });
    };
  }, []);

  // Measured, so a tall menu opened low on the screen opens upward.
  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0;
    setTop(Math.max(MARGIN, Math.min(y, window.innerHeight - height - MARGIN)));
    ref.current
      ?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [y]);

  const visible = withSeparators(sections);
  if (!visible.length) return null;

  const left = Math.max(
    MARGIN,
    Math.min(x, window.innerWidth - WIDTH - MARGIN),
  );

  function move(e: React.KeyboardEvent) {
    const items = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === 'ArrowDown'
        ? (at + 1) % items.length
        : e.key === 'ArrowUp'
          ? (at - 1 + items.length) % items.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? items.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus();
  }

  return (
    <div
      ref={ref}
      className="board-context-menu"
      data-testid={testId}
      style={{ left, top, width: WIDTH }}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={move}
      onContextMenu={(e) => e.preventDefault()}
    >
      {visible.map((section, si) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sections are a fixed, static shape per open
        <div className="board-context-menu-section" key={si}>
          {section.map((item) => (
            <button
              key={item.label}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
              aria-checked={item.checked}
              className={
                item.danger
                  ? 'board-context-menu-item board-context-menu-item--danger'
                  : 'board-context-menu-item'
              }
              data-testid={item.testId}
              disabled={item.disabled}
              title={item.disabled ? item.disabledReason : undefined}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.onSelect();
              }}
            >
              {item.checked !== undefined && (
                <span className="board-context-menu-mark" aria-hidden="true">
                  {item.checked && <span className="board-context-menu-dot" />}
                </span>
              )}
              <span className="board-context-menu-label">{item.label}</span>
              {item.keys && (
                <kbd className="board-context-menu-keys">{item.keys}</kbd>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
