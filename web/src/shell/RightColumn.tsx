// docs/ux/design.md §3.4 "Right column content, by page" / §7 slice 2:
// "move Board.tsx's inline side panel into the shell's right column". The
// page (Board.tsx today; Sheet.tsx keeps its own inline panel until slice
// 3) hands the shell whatever it wants shown there through `useRightColumn`
// — Shell.tsx owns the DOM (the `<aside>`, the collapse/overlay behaviour
// at each breakpoint), the page owns only the content.
import { type ReactNode, createContext, useContext, useEffect } from 'react';

const RightColumnContext = createContext<(node: ReactNode) => void>(() => {});

export const RightColumnSetter = RightColumnContext.Provider;

/** Registers `content` as the shell's right-column body for as long as the
 * calling component is mounted; clears it on unmount so navigating away
 * from a board never leaves a stale panel showing. */
export function useRightColumn(content: ReactNode): void {
  const setContent = useContext(RightColumnContext);
  useEffect(() => {
    setContent(content);
    return () => setContent(null);
  }, [content, setContent]);
}
