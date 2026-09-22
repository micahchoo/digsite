-- Fractions are the fact (CONTEXT.md): stored as float4 they came back one
-- digit off from what the client holds (0.294386 vs 0.294385, hour run
-- 2026-09-22), so every rows-vs-scene comparison disagreed. Double
-- precision round-trips a JSON number exactly.
ALTER TABLE regions
  ALTER COLUMN fx TYPE double precision,
  ALTER COLUMN fy TYPE double precision,
  ALTER COLUMN fw TYPE double precision,
  ALTER COLUMN fh TYPE double precision;
