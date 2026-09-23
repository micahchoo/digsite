# Phone and camera formats — 2026-09-23

Roadmap "Server — next", item 8. A folder from a phone or a camera
imports as the pictures the owner took. Before this change, HEIC and RAW
files were left out of the file list, so they were neither imported nor
counted as skipped.

## What each format needed

| format | the bundled libvips | what the import does |
| --- | --- | --- |
| HEIC (iPhone, Samsung) | fails: its libheif decodes AVIF only, not HEVC | decodes with `heic-decode` (libheif 1.23 compiled to WASM with libde265, in-process) and saves a JPEG at quality 92 |
| NEF, CR2, ARW, DNG and other TIFF-based RAW | "succeeds" at 160×120 by reading the first TIFF directory, which holds the thumbnail | takes the largest SOF0–2 JPEG in the file, the camera's own full-size rendering. It gets an EXIF orientation segment copied from the RAW; nothing is re-encoded |
| RAF, CR3 | fails | the same scan. There is no orientation to read, so none is added |

The scan passes over lossless JPEG (SOF3). SOF3 is the sensor data in a
CR2 or a DNG: a larger "JPEG" than the preview, and one that no viewer
shows. `boards/camera.ts` has the code and the reasons.

## Measured on the owner's files

| set | files | decode per file | result |
| --- | ---: | --- | --- |
| HEIC, "Image repository" (iPhone and Samsung, up to 6120×8160) | 27 | 691 ms average, 2.1 s max | every one full size and upright |
| NEF, museum artifacts (6000×4000) | 84 | 117 ms average, 217 ms max | every one full size |

Two whole folders went through a real import on a scratch database
(`runFolderImportBatch` through the worker queue):

| folder | imported | skipped | time |
| --- | ---: | ---: | ---: |
| Image repository (407 JPEG, 27 HEIC) | 434 | 0 | 31 s |
| Museum artifacts (383 JPEG, 84 NEF) | 467 | 0 | 52 s |

Peak RSS was 3.2 GB for the whole run in one process. The worker's RSS
limit bounds this in production.

## A defect this found

The first run used a data directory that did not exist. The import
skipped all 901 files, each with `ENOENT ... statfs`, and finished as
"done". Only `StorageFull` had been treated as a fault of the server.
Now only reading and checking a file can end in a skip. A failure inside
`uploadOne` stops the batch without moving the cursor, and the import
resumes on that file (`folder-import.test.ts`).

## Not done

- A browser upload still refuses HEIC and RAW with "not a recognised
  image type". Browsers turn most phone photos into JPEG before upload.
  The folder import is the path for camera cards.
- The camera file itself is not stored. The JPEG is the original, and
  `format` records what the file was. The folder on the server's disk
  still holds the file. If the owner wants the RAW kept, store it under
  `sources/` beside the original.
- `libheif-js` is LGPL-3.0. It is loaded as a separate npm module, not
  linked into our code.
