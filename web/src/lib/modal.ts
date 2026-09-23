// While a modal dialog is open (Compare, the web view, the keyboard panel,
// a folder import), its keys are its own. A page-level key handler that
// also answered them closed the picture's details on the Esc that only
// meant "close the comparison" (found 2026-09-23). Every window-level key
// handler asks this first.

export function modalOpen(): boolean {
  for (const dialog of document.querySelectorAll('dialog[open]'))
    if (dialog.matches(':modal')) return true;
  return false;
}
