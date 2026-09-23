// docs/ux/design.md §5.2 "Board Actions menu / right-click": grouped
// exactly as image-graph's `menu()` groups them — sections separated by a
// divider only when BOTH the previous and the next group actually have an
// item, never a leading or trailing one. Reachable identically from the
// `⋯` "Actions" button, a right-click on the canvas, and (design's own
// "one action, three surfaces" — image-graph's `view.ts#menu`).
import { useEffect, useRef } from 'react';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Shown as a `title` attribute when disabled — never "coming soon"
   * (design.md §6/keep-writing conventions: state the reason or say
   * nothing). */
  disabledReason?: string;
  testId?: string;
}
export type MenuSection = MenuItem[];

interface Props {
  x: number;
  y: number;
  sections: MenuSection[];
  onClose: () => void;
}

/** Only inserts a separator between two sections that both have items —
 * image-graph's own `section()` rule, ported. */
function withSeparators(sections: MenuSection[]): MenuSection[] {
  return sections.filter((s) => s.length > 0);
}

export function ContextMenu({ x, y, sections, onClose }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onDocPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const visible = withSeparators(sections);
  if (!visible.length) return null;

  // Clamp so the menu never renders off the right/bottom edge.
  const width = 240;
  const left = Math.min(x, window.innerWidth - width - 8);
  const top = Math.min(y, window.innerHeight - 8);

  return (
    <div
      ref={ref}
      className="board-context-menu"
      data-testid="board-context-menu"
      style={{ left, top, width }}
      role="menu"
    >
      {visible.map((section, si) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: sections are a fixed, static shape per open
        <div className="board-context-menu-section" key={si}>
          {section.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="board-context-menu-item"
              data-testid={item.testId}
              disabled={item.disabled}
              title={item.disabled ? item.disabledReason : undefined}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
