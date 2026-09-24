import { stopAllUploadQueues } from '../board/upload.ts';
import { authClient } from '../lib/auth.ts';

// Slice 2 follow-up (c): after "sign out", a reload must show the sign-in
// page every time. `authClient.signOut()` alone raced — the session
// nanostore could still read "signed in" for a tick after the cookie
// cleared (smoke-groups.ts's own header comment on the flake it worked
// around by clearing the cookie directly instead of using this button).
// Awaiting the request, THEN hard-navigating with `window.location.href`
// (never `navigate()`) throws away every in-memory store — better-auth's
// session cache included — so there is nothing stale left to race a
// reload against.
export async function signOut() {
  stopAllUploadQueues();
  await authClient.signOut();
  window.location.href = '/';
}
