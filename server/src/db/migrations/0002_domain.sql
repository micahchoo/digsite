-- Domain tables: boards, images, ranks, sheets, claims. See docs/design.md
-- "server/src/db/" and CONTEXT.md for the words. `org_id`/`created_by`/
-- `uploaded_by` reference Better Auth's `organization`/`user` (0001_auth.sql)
-- by their text ids; not FKs, since those tables are the plugin's schema.
CREATE TABLE boards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       text NOT NULL,                 -- organization.id
  name         text NOT NULL,
  open         boolean NOT NULL,
  team_id      text,                          -- team.id when private
  created_by   text NOT NULL,                 -- user.id
  default_sort text NOT NULL DEFAULT 'uploaded_at.desc',
  image_count  integer NOT NULL DEFAULT 0,    -- next slot
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE images (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id    uuid NOT NULL REFERENCES boards(id),
  slot        integer NOT NULL,
  sha256      text NOT NULL,
  name        text NOT NULL,
  width       integer NOT NULL,
  height      integer NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by text NOT NULL,
  properties  jsonb NOT NULL DEFAULT '{}',
  missing     boolean NOT NULL DEFAULT false,
  UNIQUE (board_id, slot)
);

CREATE TABLE board_ranks (
  board_id uuid NOT NULL REFERENCES boards(id),
  sort_id  text NOT NULL,
  rank     integer NOT NULL,
  slot     integer NOT NULL,
  PRIMARY KEY (board_id, sort_id, rank)
);

CREATE TABLE board_rank_state (
  board_id uuid NOT NULL REFERENCES boards(id),
  sort_id  text NOT NULL,
  built_at timestamptz NOT NULL,
  stale    boolean NOT NULL DEFAULT false,
  PRIMARY KEY (board_id, sort_id)
);

CREATE TABLE sheets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id   uuid NOT NULL REFERENCES boards(id),
  name       text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sheet_images (
  sheet_id uuid NOT NULL REFERENCES sheets(id),
  image_id uuid NOT NULL REFERENCES images(id),
  PRIMARY KEY (sheet_id, image_id)
);

CREATE TABLE sheet_snapshots (
  sheet_id uuid PRIMARY KEY REFERENCES sheets(id),
  elements jsonb NOT NULL,
  saved_at timestamptz NOT NULL
);

CREATE TABLE regions (
  id         text PRIMARY KEY,                -- claimId(sheet, source)
  sheet_id   uuid NOT NULL REFERENCES sheets(id),
  source_id  text NOT NULL,
  image_id   uuid NOT NULL REFERENCES images(id),
  fx real NOT NULL, fy real NOT NULL, fw real NOT NULL, fh real NOT NULL,
  label      text NOT NULL DEFAULT '',
  properties jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE edges (
  id                   text PRIMARY KEY,
  sheet_id             uuid NOT NULL REFERENCES sheets(id),
  source_id            text NOT NULL,
  src_image_id         uuid NOT NULL REFERENCES images(id),
  src_region_source_id text,
  dst_image_id         uuid NOT NULL REFERENCES images(id),
  dst_region_source_id text,
  direction            text NOT NULL,
  relation             text NOT NULL DEFAULT '',
  properties           jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX ON images (board_id, uploaded_at DESC, slot);
CREATE INDEX ON images (board_id, name, slot);
CREATE INDEX ON regions (image_id);
CREATE INDEX ON edges (src_image_id);
CREATE INDEX ON edges (dst_image_id);
