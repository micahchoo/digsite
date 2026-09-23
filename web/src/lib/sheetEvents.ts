// Slice 2 follow-up (a) (docs/ux/design.md §7): the channel column
// (shell/useShellData.ts) fetches its board/sheet list once per navigation
// and otherwise has no idea a sheet was created, renamed, deleted or had
// images added elsewhere on the page (Board.tsx's tray, the sheet page
// itself). A page that mutates a sheet calls `notifySheetsChanged()` after
// the request succeeds; `useShellData` subscribes and refetches — an event
// the pages emit, never a poll.
type Listener = () => void;
const listeners = new Set<Listener>();

export function notifySheetsChanged(): void {
  for (const l of listeners) l();
}

export function onSheetsChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
