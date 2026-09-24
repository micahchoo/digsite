// The direction glyphs, drawn: the one set of paths a connection's direction
// is shown with, in the app (web/src/components/Icon.tsx) and in a report
// document (report/document.ts), which cannot import the web. A typed arrow
// renders in whatever font the reader has; these do not. 20-unit grid, one
// stroke, as every Icon.
export const DIRECTION_PATHS = {
  forward: 'M4.5 10h11m0 0L11 5.5m4.5 4.5L11 14.5',
  reverse: 'M15.5 10h-11m0 0L9 5.5M4.5 10 9 14.5',
  both: 'M4.5 10h11M4.5 10 8 6.5M4.5 10 8 13.5m7.5-3.5L12 6.5m3.5 3.5L12 13.5',
  none: 'M4.5 10h11',
} as const;

/** How a direction reads aloud, between the two ends' names. */
export const DIRECTION_WORDS = {
  forward: 'to',
  reverse: 'from',
  both: 'and back, with',
  none: 'with',
} as const;
