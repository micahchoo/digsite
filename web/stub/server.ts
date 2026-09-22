// A throwaway dev stub — enough of docs/design.md's server contract to drive
// every web/ page without the real server running. Not product code. Reuses
// @digsite/shared wherever the real server would (grid math, fractions,
// project()), so the fixture stays honest about the contract.
import { createServer } from 'node:http';
import {
  type SceneElement,
  type Sort,
  arrowheadsFor,
  cellPx,
  fileId,
  fromFraction,
  imageGroupId,
  parseSortId,
  project,
  tileRanks,
} from '@digsite/shared';
import { createCanvas } from '@napi-rs/canvas';
import { type Socket, Server as SocketServer } from 'socket.io';

const PORT = 8800;
const WEB_ORIGIN = 'http://localhost:5180';
const IMAGE_COUNT = 60;
const FAKE_USER = { id: 'u1', email: 'owner@example.test', name: 'Owner' };
const COOKIE = 'digsite.stub_session';

const range = (a: number, b: number): number[] =>
  Array.from({ length: b - a }, (_, i) => a + i);

// -- fixture: one group, two boards, 60 images on the open one --------------
const GROUP = { id: 'g1', name: 'Lab', role: 'owner' as const };
const BOARDS = [
  { id: 'b1', name: 'Field', open: true, imageCount: IMAGE_COUNT },
  { id: 'b2', name: 'Finds', open: false, imageCount: 0 },
];
const MEMBERS = [
  {
    userId: FAKE_USER.id,
    email: FAKE_USER.email,
    name: FAKE_USER.name,
    role: 'owner' as const,
  },
];

interface Img {
  id: string;
  slot: number;
  name: string;
  width: number;
  height: number;
  uploadedAt: string;
  properties: { year: number; site: string };
  missing: boolean;
}
const makeImg = (slot: number): Img => ({
  id: `img-${slot}`,
  slot,
  name: `image-${slot}`,
  width: 256,
  height: 256,
  uploadedAt: new Date(
    Date.now() - (IMAGE_COUNT - slot) * 60_000,
  ).toISOString(),
  properties: { year: 1900 + (slot % 60), site: `site-${slot % 5}` },
  missing: false,
});
let images: Img[] = range(0, IMAGE_COUNT).map(makeImg);

const SORTABLE_KEYS = [
  { key: 'name' as const, label: 'name' },
  { key: 'uploaded_at' as const, label: 'uploaded' },
  { key: { property: 'year', type: 'number' as const }, label: 'year' },
  { key: { property: 'site', type: 'text' as const }, label: 'site' },
];

function rankedImages(sort: Sort): Img[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  const key = sort.key;
  const value = (img: Img): string | number =>
    key === 'name'
      ? img.name
      : key === 'uploaded_at'
        ? img.uploadedAt
        : ((img.properties as Record<string, string | number>)[key.property] ??
          '');
  return [...images].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    return va < vb ? -dir : va > vb ? dir : a.slot - b.slot;
  });
}

// -- sheets: two, sharing a region+edge pair on images 8 & 9 ----------------
const SHEET_IMAGES: {
  s1: number[];
  s2: number[];
  [sheetId: string]: number[];
} = {
  s1: range(0, 12),
  s2: range(6, 18),
};
const SHEET_NAME: Record<string, string> = { s1: 'First pass', s2: 'Faces' };

// biome-ignore lint/suspicious/noExplicitAny: minimal Excalidraw skeletons; restoreElements fills the rest client-side
const el = (partial: Record<string, unknown>): any => ({
  version: 1,
  versionNonce: 1,
  isDeleted: false,
  updated: Date.now(),
  ...partial,
});

function grid(imageIds: string[]): SceneElement[] {
  return imageIds.map((id, i) =>
    el({
      id: `seed-img-${id}`,
      type: 'image',
      x: (i % 5) * 320,
      y: Math.floor(i / 5) * 320,
      width: 256,
      height: 256,
      fileId: fileId(id),
      customData: { kind: 'image', imageId: id },
      groupIds: [imageGroupId(id)],
    }),
  );
}

/** Sheet s1's seed, plus one region on images 8 and 9 and an edge between
 * them — what s2 (which also holds 8 and 9) sees as foreign. */
function seedS1(): SceneElement[] {
  const els = grid(SHEET_IMAGES.s1.map((slot) => `img-${slot}`));
  const img8 = els.find(
    (e) => (e.customData as { imageId?: string })?.imageId === 'img-8',
  );
  const img9 = els.find(
    (e) => (e.customData as { imageId?: string })?.imageId === 'img-9',
  );
  if (!img8 || !img9) return els;

  const rect8 = fromFraction({ fx: 0.1, fy: 0.1, fw: 0.35, fh: 0.35 }, img8);
  const rect9 = fromFraction({ fx: 0.5, fy: 0.5, fw: 0.3, fh: 0.3 }, img9);
  const region = (
    id: string,
    imageId: string,
    rect: typeof rect8,
    label: string,
  ) =>
    el({
      id,
      type: 'rectangle',
      ...rect,
      groupIds: [imageGroupId(imageId)],
      customData: { kind: 'region', imageId, label, properties: {} },
    });
  const region8 = region('seed-region-8', 'img-8', rect8, 'find');
  const region9 = region('seed-region-9', 'img-9', rect9, 'fragment');

  const heads = arrowheadsFor('forward');
  const [ax, ay] = [rect8.x + rect8.width / 2, rect8.y + rect8.height / 2];
  const [bx, by] = [rect9.x + rect9.width / 2, rect9.y + rect9.height / 2];
  const edge = el({
    id: 'seed-edge-8-9',
    type: 'arrow',
    x: ax,
    y: ay,
    width: Math.abs(bx - ax) || 1,
    height: Math.abs(by - ay) || 1,
    points: [
      [0, 0],
      [bx - ax, by - ay],
    ],
    startArrowhead: heads.startArrowhead,
    endArrowhead: heads.endArrowhead,
    startBinding: { elementId: 'seed-region-8' },
    endBinding: { elementId: 'seed-region-9' },
    customData: {
      kind: 'edge',
      relation: 'resembles',
      direction: 'forward',
      properties: {},
    },
  });
  return [...els, region8, region9, edge];
}

const elementsBySheet: Record<string, SceneElement[]> = {
  s1: seedS1(),
  s2: grid(SHEET_IMAGES.s2.map((slot) => `img-${slot}`)),
};
const peersBySheet: Record<string, Set<string>> = {
  s1: new Set(),
  s2: new Set(),
};
const stats = { scenes: 0, broadcasts: 0, snapshots: 0, lastProjectionMs: 0 };

/** Rows from OTHER sheets whose images `sheetId` holds — GET /sheets/:id/foreign. */
function foreignFor(sheetId: string) {
  const held = new Set(SHEET_IMAGES[sheetId]?.map((slot) => `img-${slot}`));
  const regions: unknown[] = [];
  const edges: unknown[] = [];
  for (const [otherId, els] of Object.entries(elementsBySheet)) {
    if (otherId === sheetId) continue;
    const { regions: r, edges: e } = project(otherId, els);
    for (const row of r)
      if (held.has(row.imageId))
        regions.push({ ...row, sheetName: SHEET_NAME[otherId] });
    for (const row of e) {
      if (held.has(row.source.imageId) && held.has(row.target.imageId)) {
        edges.push({ ...row, sheetName: SHEET_NAME[otherId] });
      }
    }
  }
  return { regions, edges };
}

// -- tiles: z/x/y label plus each cell's rank, so the URL mapping is checkable by eye --
function renderTile(sid: string, z: number, x: number, y: number): Buffer {
  const size = 256;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#20242b';
  ctx.fillRect(0, 0, size, size);

  const sort = parseSortId(sid);
  const count = sort ? rankedImages(sort).length : 0;
  const zz = z as -5 | -4 | -3 | -2 | -1 | 0;
  const px = cellPx(zz);
  const n = Math.round(size / px);
  for (const [i, rank] of tileRanks(zz, x, y).entries()) {
    const cx = (i % n) * px;
    const cy = Math.floor(i / n) * px;
    ctx.fillStyle =
      rank >= 0 && rank < count
        ? `hsl(${(rank * 137.508) % 360}, 55%, 42%)`
        : '#333a44';
    ctx.fillRect(cx, cy, px, px);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(cx + 0.5, cy + 0.5, px - 1, px - 1);
    if (px >= 20 && rank >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.font = `${Math.min(13, Math.floor(px * 0.28))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(rank), cx + px / 2, cy + px / 2);
    }
  }
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(`${z}/${x}/${y}`, size / 2, 4);
  return canvas.toBuffer('image/png');
}

function paintImage(imageId: string): Buffer {
  const slot = Number(imageId.replace('img-', '')) || 0;
  const S = 256;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = `hsl(${(slot * 137.508) % 360}, 65%, 55%)`;
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.font = '40px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(slot), S / 2, S / 2);
  return canvas.toBuffer('image/png');
}

const tileSeen = new Set<string>();

// cors/json/hasSession/setSessionCookie close over this one request's
// req/res rather than taking them as typed parameters — bun's bundled
// node:http typings give the listener's `res` an extra `{ req }`
// intersection member that a standalone `ServerResponse` annotation doesn't
// carry, so the two don't unify across a function boundary.
const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  function json(status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  res.setHeader('Access-Control-Allow-Origin', WEB_ORIGIN);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader(
    'Access-Control-Allow-Methods',
    'GET,POST,PATCH,DELETE,OPTIONS',
  );
  res.setHeader('Access-Control-Expose-Headers', 'X-Cache, Server-Timing');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname.startsWith('/socket.io')) return;

  // -- auth (fake) -----------------------------------------------------------
  if (url.pathname === '/api/auth/get-session') {
    const has = (req.headers.cookie ?? '').includes(COOKIE);
    return has
      ? json(200, {
          session: { id: 'sess1', userId: FAKE_USER.id },
          user: FAKE_USER,
        })
      : json(200, null);
  }
  if (
    url.pathname === '/api/auth/sign-in/email' ||
    url.pathname === '/api/auth/sign-up/email'
  ) {
    res.setHeader('Set-Cookie', `${COOKIE}=1; Path=/; SameSite=Lax`);
    return json(200, { user: FAKE_USER });
  }
  if (url.pathname === '/api/auth/sign-out') {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0`);
    return json(200, {});
  }

  // -- groups ------------------------------------------------------------------
  if (url.pathname === '/groups' && req.method === 'GET')
    return json(200, [GROUP]);
  if (url.pathname === '/groups' && req.method === 'POST')
    return json(201, { id: GROUP.id });
  if (/^\/groups\/[^/]+\/invite$/.test(url.pathname))
    return json(200, { invitationId: 'inv-1' });
  if (/^\/invitations\/[^/]+\/accept$/.test(url.pathname))
    return json(200, { groupId: GROUP.id });
  if (/^\/groups\/[^/]+\/members$/.test(url.pathname))
    return json(200, MEMBERS);
  if (/^\/groups\/[^/]+\/leave$/.test(url.pathname)) return json(200, {});

  // -- boards --------------------------------------------------------------------
  const boardsList = url.pathname.match(/^\/groups\/[^/]+\/boards$/);
  if (boardsList && req.method === 'GET') return json(200, BOARDS);
  if (boardsList && req.method === 'POST') return json(201, { id: 'b1' });

  const boardOne = url.pathname.match(/^\/boards\/([^/]+)$/);
  if (boardOne && req.method === 'GET') {
    const board = BOARDS.find((b) => b.id === boardOne[1]);
    if (!board) return json(404, { reason: 'not found' });
    return json(200, {
      ...board,
      defaultSort: 'uploaded_at.desc',
      sortableKeys: SORTABLE_KEYS,
    });
  }

  const boardImages = url.pathname.match(/^\/boards\/([^/]+)\/images$/);
  if (boardImages && req.method === 'GET') {
    const sort = parseSortId(url.searchParams.get('sort') ?? '') ?? {
      key: 'uploaded_at' as const,
      dir: 'desc' as const,
    };
    const from = Number(url.searchParams.get('from') ?? '0');
    const count = Number(url.searchParams.get('count') ?? '50');
    return json(200, { images: rankedImages(sort).slice(from, from + count) });
  }
  if (boardImages && req.method === 'POST') {
    // dev stub: count "files" parts in the multipart body, add that many synthetic images
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const added = Math.max(
      1,
      (
        Buffer.concat(chunks)
          .toString('latin1')
          .match(/name="files"/g) ?? []
      ).length,
    );
    const created = range(images.length, images.length + added).map(makeImg);
    images = [...images, ...created];
    const board = BOARDS.find((b) => b.id === boardImages[1]);
    if (board) board.imageCount = images.length;
    return json(
      201,
      created.map((i) => ({ id: i.id, slot: i.slot })),
    );
  }

  const tileMatch = url.pathname.match(
    /^\/boards\/([^/]+)\/tiles\/([^/]+)\/(-?\d+)\/(-?\d+)\/(-?\d+)\.png$/,
  );
  if (tileMatch) {
    const [, , sid, zs, xs, ys] = tileMatch;
    const key = `${sid}/${zs}/${xs}/${ys}`;
    const hit = tileSeen.has(key);
    tileSeen.add(key);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'X-Cache': hit ? 'hit' : 'miss',
      'Server-Timing': `rank;dur=0.5, compose;dur=${hit ? 0 : 5}`,
      'Cache-Control': 'private, max-age=60',
    });
    res.end(renderTile(sid ?? '', Number(zs), Number(xs), Number(ys)));
    return;
  }

  const imageOriginal = url.pathname.match(/^\/images\/([^/]+)\/original$/);
  if (imageOriginal) {
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(paintImage(imageOriginal[1] ?? ''));
    return;
  }
  const imageOne = url.pathname.match(/^\/images\/([^/]+)$/);
  if (imageOne && req.method === 'GET') {
    const img = images.find((i) => i.id === imageOne[1]);
    return img
      ? json(200, { ...img, boardId: 'b1' })
      : json(404, { reason: 'not found' });
  }

  // -- sheets ----------------------------------------------------------------------
  const sheetsList = url.pathname.match(/^\/boards\/([^/]+)\/sheets$/);
  if (sheetsList && req.method === 'GET') {
    return json(
      200,
      Object.keys(SHEET_NAME).map((id) => ({
        id,
        name: SHEET_NAME[id],
        createdAt: new Date().toISOString(),
      })),
    );
  }
  if (sheetsList && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      name: string;
      imageIds: string[];
    };
    const id = `s${Object.keys(SHEET_NAME).length + 1}`;
    SHEET_NAME[id] = body.name;
    SHEET_IMAGES[id] = body.imageIds.map((imgId) =>
      Number(imgId.replace('img-', '')),
    );
    elementsBySheet[id] = grid(body.imageIds);
    peersBySheet[id] = new Set();
    return json(201, { id });
  }

  const sheetOne = url.pathname.match(/^\/sheets\/([^/]+)$/);
  if (sheetOne && req.method === 'GET') {
    const id = sheetOne[1] ?? '';
    if (!SHEET_NAME[id]) return json(404, { reason: 'not found' });
    const imgs = (SHEET_IMAGES[id] ?? []).map((slot) => {
      const img = images.find((i) => i.slot === slot);
      return {
        id: `img-${slot}`,
        slot,
        width: img?.width ?? 256,
        height: img?.height ?? 256,
      };
    });
    return json(200, { id, name: SHEET_NAME[id], boardId: 'b1', images: imgs });
  }
  if (/^\/sheets\/[^/]+\/elements$/.test(url.pathname)) {
    return json(200, {
      elements: elementsBySheet[url.pathname.split('/')[2] ?? ''] ?? [],
    });
  }
  if (/^\/sheets\/[^/]+\/foreign$/.test(url.pathname)) {
    return json(200, foreignFor(url.pathname.split('/')[2] ?? ''));
  }
  if (/^\/sheets\/[^/]+\/rows$/.test(url.pathname)) {
    const id = url.pathname.split('/')[2] ?? '';
    return json(200, project(id, elementsBySheet[id] ?? []));
  }
  if (url.pathname === '/stats')
    return json(200, { ...stats, foreignInScene: 0 });

  json(404, { reason: 'not found' });
});

const io = new SocketServer(httpServer, {
  cors: { origin: WEB_ORIGIN, credentials: true },
});

io.on('connection', (socket: Socket) => {
  socket.on('join', ({ sheetId }: { sheetId: string }) => {
    if (!SHEET_NAME[sheetId]) {
      socket.emit('join-denied', { reason: 'not found' });
      socket.disconnect(true);
      return;
    }
    socket.join(sheetId);
    socket.data.sheetId = sheetId;
    peersBySheet[sheetId]?.add(socket.id);
    const peers = Array.from(peersBySheet[sheetId] ?? []);
    socket.emit('joined', { elements: elementsBySheet[sheetId], peers });
    io.to(sheetId).emit('peers', { users: peers });
  });

  socket.on('scene', ({ elements }: { elements: SceneElement[] }) => {
    const sheetId = socket.data.sheetId as string | undefined;
    if (!sheetId) return;
    elementsBySheet[sheetId] = elements;
    stats.scenes++;
    stats.broadcasts++;
    stats.snapshots++;
    socket.to(sheetId).emit('scene', { elements, from: socket.id });
  });

  socket.on('disconnect', () => {
    const sheetId = socket.data.sheetId as string | undefined;
    if (!sheetId) return;
    peersBySheet[sheetId]?.delete(socket.id);
    io.to(sheetId).emit('peers', {
      users: Array.from(peersBySheet[sheetId] ?? []),
    });
  });
});

httpServer.listen(PORT, () =>
  console.log(`digsite stub on http://localhost:${PORT}`),
);
