// docs/ux/audit.md #12: "1 images" (the sheet list under a board) and an
// audit for every other un-pluralized count. One helper, used everywhere a
// count is shown next to a word — `board/messages.ts` had its own private
// copy before this (the delete-confirm sentences); every other call site
// interpolated `${n} images` etc. directly and never pluralized at all.
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}
