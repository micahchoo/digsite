// Makes the board the GIFs are recorded on: a "Collection" board in the
// group GROUP, filled from the folder fetch-aic.ts wrote, one property per
// catalogue field. Paintings, prints and furniture are left out.
import { signIn } from '../../../e2e/src/session.ts';
const DIR = process.argv[2];
const drop = new Set([
  'Print',
  'Painting',
  'Furniture',
  'Furnishings',
  'Textile',
]);
// One entry of fetch-aic.ts's meta.json.
type Meta = {
  file: string;
  query: string;
  id: number;
  title: string;
  place: string | null;
  year: number | null;
  medium: string | null;
  type: string;
};
const all: Meta[] = await Bun.file(`${DIR}/meta.json`).json();
const meta = all.filter((m) => !drop.has(m.type));
const GROUP = process.env.GROUP;
if (!GROUP)
  throw new Error('set GROUP to the id of the group the board goes in');
const s = await signIn(
  process.env.EMAIL ?? 'owner@example.test',
  process.env.PASSWORD ?? 'password1234',
);
const b = await s.post<{ id: string }>(`/groups/${GROUP}/boards`, {
  name: 'Collection',
  open: true,
});
if (b.status !== 200) throw new Error(JSON.stringify(b));
const board = b.json.id;
console.log('board', board);
const clean = (t: string) =>
  t
    .replace(/[\/\\:*?"<>|]/g, ' ')
    .slice(0, 60)
    .trim();
for (let i = 0; i < meta.length; i += 20) {
  const chunk = meta.slice(i, i + 20);
  const form = new FormData();
  for (const m of chunk)
    form.append(
      'files',
      new Blob([await Bun.file(`${DIR}/${m.file}`).arrayBuffer()], {
        type: 'image/jpeg',
      }),
      `${clean(m.title)}.jpg`,
    );
  const up = await s.postForm<{ id: string }[]>(
    `/boards/${board}/images`,
    form,
  );
  if (up.status !== 202)
    throw new Error(`${up.status} ${JSON.stringify(up.json)}`);
  for (const [j, img] of up.json.entries()) {
    const m = chunk[j];
    if (!m) continue;
    // `aic` is the artwork's id at the source: study.ts names pictures by it.
    const properties: Record<string, unknown> = {
      type: m.type,
      find: m.query,
      aic: m.id,
    };
    if (m.place) properties.place = m.place;
    if (typeof m.year === 'number') properties.year = m.year;
    if (m.medium) properties.medium = m.medium.slice(0, 80);
    const p = await s.patch(`/images/${img.id}`, { properties });
    if (p.status !== 200)
      console.log('prop fail', p.status, JSON.stringify(p.json));
  }
  console.log('uploaded', i + chunk.length);
}
