-- Sheet rooms across API processes (roadmap item 1): the Socket.IO
-- Postgres adapter relays room broadcasts over LISTEN/NOTIFY. A NOTIFY
-- carries at most 8,000 bytes, and a sheet's scene is usually larger, so
-- the adapter parks such payloads here and notifies their id; it deletes
-- old rows itself (cleanupInterval). Shape as the adapter documents it.
CREATE TABLE IF NOT EXISTS socket_io_attachments (
  id         bigserial UNIQUE,
  created_at timestamptz DEFAULT now(),
  payload    bytea
);
