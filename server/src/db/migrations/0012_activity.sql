-- Phase 6 (docs/phases/6-product.md "Group activity feed"): the homepage
-- guestbook. `board_id` is NULL for a group-level event (a member joining);
-- set for a board-scoped one (created, images uploaded, a sheet started) so
-- GET /groups/:id/activity can filter out events about a private board the
-- viewer isn't on (access/index.ts#activityForGroupListing) — the same
-- open-or-allowlist predicate as everywhere else, never duplicated here.
CREATE TABLE activity (
  id         bigserial PRIMARY KEY,
  group_id   text NOT NULL,        -- organization.id
  board_id   uuid REFERENCES boards(id),
  kind       text NOT NULL,        -- 'board_created' | 'images_uploaded' | 'sheet_started' | 'member_joined'
  actor_id   text NOT NULL,        -- user.id
  payload    jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON activity (group_id, at DESC);
