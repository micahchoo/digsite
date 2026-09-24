// Public-domain (CC0) objects from the Art Institute of Chicago API.
export {};

const OUT = process.argv[2];
const H = { 'AIC-User-Agent': 'digsite-readme' };
const queries = [
  'amphora',
  'vessel fragment',
  'scarab',
  'coin',
  'oil lamp',
  'seal',
  'figurine',
  'kylix',
  'bead',
  'cylinder seal',
  'bowl',
  'mask',
];
const per = 13;
type Found = {
  id: number;
  title: string;
  image_id: string | null;
  place_of_origin: string | null;
  date_display: string | null;
  date_start: number | null;
  medium_display: string | null;
  artwork_type_title: string;
};
const meta: object[] = [];
const seen = new Set<number>();
for (const q of queries) {
  const url = `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(q)}&query[term][is_public_domain]=true&fields=id,title,image_id,place_of_origin,date_display,date_start,medium_display,artwork_type_title,department_title&limit=40`;
  const { data } = (await (await fetch(url, { headers: H })).json()) as {
    data: Found[];
  };
  let got = 0;
  for (const o of data) {
    if (got >= per) break;
    if (!o.image_id || seen.has(o.id)) continue;
    const img = await fetch(
      `https://www.artic.edu/iiif/2/${o.image_id}/full/600,/0/default.jpg`,
      { headers: H },
    );
    if (!img.ok) continue;
    seen.add(o.id);
    const file = `aic-${o.id}.jpg`;
    await Bun.write(`${OUT}/${file}`, await img.arrayBuffer());
    meta.push({
      file,
      query: q,
      id: o.id,
      title: o.title,
      place: o.place_of_origin,
      date: o.date_display,
      year: o.date_start,
      medium: o.medium_display,
      type: o.artwork_type_title,
    });
    got++;
    await Bun.sleep(100);
  }
  console.log(q, got);
  await Bun.write(`${OUT}/meta.json`, JSON.stringify(meta, null, 1));
}
