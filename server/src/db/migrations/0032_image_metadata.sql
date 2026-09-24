-- CONTEXT.md "File metadata": everything a picture's file carries about
-- itself (EXIF, GPS, IPTC, XMP), read on first ask and kept here, with the
-- format its bytes are (boards/metadata.ts). Null until someone asks;
-- never edited, because the file said it.
ALTER TABLE images ADD COLUMN metadata jsonb;
