// docs/phases/2-sheet.md section 3 ("Presence"): two socket.io-clients join
// the same sheet room and check, by hand, what the tests can't cheaply
// cover end to end — the pointer relay's shape (`{user, name, x, y,
// selectedIds}`) and the 20/s-per-socket server-side cap.
//
// Needs a running server (`bun run dev`, or PORT=8805 for the phase-2
// server port this agent was given) and an existing sheet both users can
// reach — `bun run seed` makes group "Lab" / board "Field" (open) with
// `owner@example.test` and `member@example.test`; create a sheet on it
// first (through the web app, or `POST /boards/:id/sheets`) and pass its id
// here.
//
//   bun run scripts/presence-smoke.ts <sheetId> [email1] [email2]
import { type Socket, io as ioClient } from 'socket.io-client';
import { env } from '../src/env.ts';

const sheetId = process.argv[2];
const email1 = process.argv[3] ?? 'owner@example.test';
const email2 = process.argv[4] ?? 'member@example.test';
const password = 'password1';

if (!sheetId) {
  console.error(
    'usage: bun run scripts/presence-smoke.ts <sheetId> [email1] [email2]',
  );
  process.exit(1);
}

async function signIn(email: string): Promise<string> {
  const res = await fetch(`${env.SERVER_ORIGIN}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: env.SERVER_ORIGIN },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) {
    throw new Error(`sign-in failed for ${email}: ${res.status}`);
  }
  const setCookie = res.headers.get('set-cookie');
  const cookie = setCookie?.split(';')[0];
  if (!cookie) throw new Error(`sign-in for ${email} returned no cookie`);
  return cookie;
}

function connect(cookie: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(env.SERVER_ORIGIN, {
      extraHeaders: { cookie },
      transports: ['websocket'],
    });
    socket.on('connect_error', reject);
    socket.on('joined', () => resolve(socket));
    socket.on('join-denied', (payload: { reason: string }) =>
      reject(new Error(`join denied: ${payload.reason}`)),
    );
    socket.emit('join', { sheetId });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(`signing in ${email1} and ${email2}...`);
  const [cookie1, cookie2] = await Promise.all([
    signIn(email1),
    signIn(email2),
  ]);

  console.log('joining the sheet room...');
  const [sender, listener] = await Promise.all([
    connect(cookie1),
    connect(cookie2),
  ]);

  const received: { user: string; name: string; x: number; y: number }[] = [];
  listener.on(
    'pointer',
    (p: { user: string; name: string; x: number; y: number }) => {
      received.push(p);
    },
  );

  // 40 events in ~1s, twice the 20/s cap — every event after the 20th in a
  // given second should be dropped server-side, not queued for later.
  const SENT = 40;
  console.log(`sending ${SENT} pointer events over ~1s (cap is 20/s)...`);
  const start = Date.now();
  for (let i = 0; i < SENT; i++) {
    sender.emit('pointer', { x: i, y: i * 2, selectedIds: [] });
    await sleep(1000 / SENT);
  }
  const elapsedMs = Date.now() - start;

  // give the last few relays time to arrive
  await sleep(300);

  console.log(
    `sent ${SENT} in ${elapsedMs}ms, listener received ${received.length}`,
  );
  const first = received[0];
  if (first) {
    console.log('sample relayed payload:', first);
    if (typeof first.user !== 'string' || typeof first.name !== 'string') {
      throw new Error('relayed pointer payload is missing user/name');
    }
  } else {
    throw new Error('listener received no pointer events at all');
  }

  if (received.length > 20) {
    throw new Error(
      `cap not enforced: listener received ${received.length} pointer events for ${SENT} sent in ~1s`,
    );
  }
  if (received.length === SENT) {
    console.warn(
      'warning: every event arrived — the send loop may be slower than 1s; rerun or shorten the sleep to actually exercise the cap',
    );
  }

  console.log(
    'presence smoke OK: relay shape correct, cap held at',
    received.length,
    '<= 20',
  );
  sender.disconnect();
  listener.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
