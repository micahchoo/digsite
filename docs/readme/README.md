# The README's recordings

The six GIFs in this folder are recorded from a running digsite by
`scripts/`. Record them again when the board or the sheet changes how it
looks.

A take is one Playwright video with marks in it; each mark starts a
segment, and each segment becomes one GIF. `board.ts` records `map` and
`find`; `sheet.ts` records `start`, `draw` and `compare`; `props.ts`
records `properties` on the sheet `sheet.ts` leaves.

## Make the board once

The pictures are public domain (CC0) from the Art Institute of Chicago's
API. `fetch-aic.ts` saves about 150 of them with their catalogue fields;
`load.ts` uploads them to a new "Collection" board and prints its id.

```
bun docs/readme/scripts/fetch-aic.ts /tmp/aic
cd e2e && GROUP=<group id> bun ../docs/readme/scripts/load.ts /tmp/aic
```

## Fill it with a study

`study.ts` is an example of the board in use: six sheets, each a question a
student of the collection would ask ("Names of kings", "What \"seal\"
means", …), with 54 regions and 29 connections, their properties,
confidence and notes. `annotate.ts` draws it through the sheet page's own
tools, so the claims are stamped and projected like hand-drawn ones.

```
cd e2e && BOARD=<board id> SERVER_ORIGIN=... WEB_ORIGIN=... bun ../docs/readme/scripts/annotate.ts
```

It finds each picture by the `aic` property `load.ts` sets, so it needs a
board loaded by this `load.ts`. A search that no longer returns a picture
the study names stops the run and names the id. Each run adds six sheets;
`clean.ts` removes them, and it also removes the ones the recordings need.

Run it with `EMBEDDINGS=on` on the server: `find` asks by meaning and
arranges by meaning.

## Record

From `e2e/` (Playwright lives there), with the server and web running:

```
export BOARD=<board id> SERVER_ORIGIN=http://localhost:8800 WEB_ORIGIN=http://localhost:5180
bun ../docs/readme/scripts/clean.ts
bun ../docs/readme/scripts/board.ts
bun ../docs/readme/scripts/sheet.ts
bun ../docs/readme/scripts/props.ts
for s in map find start draw compare properties; do ../docs/readme/scripts/togif.sh $s; done
```

`clean.ts` deletes the board's sheets first. Without it, the sheets that
earlier takes left show their regions on the new one as foreign claims.

`sheet.ts` draws its regions at fixed scene coordinates: the painted
centres of two cups where the sheet lays them out for this board. On a
different board, find the new ones.

Each GIF is 800 px wide at 10 frames a second, about 2 MB. `togif.sh`
takes the width and the rate as its second and third arguments. The
viewport is 1200 × 760 because below 1280 px the board's side panel
floats, and the map gets the width.
