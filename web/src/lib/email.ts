// docs/ux/audit.md #7: the invite form let a malformed email (or an empty
// one sent as `email: ''`) through to the server, which 500s on both —
// "Internal Server Error" with no way to fix it. Not RFC 5322 — one `@`,
// something on each side, a dot somewhere after it — the same shallow
// check every sign-up form uses; the server remains the real authority.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}
