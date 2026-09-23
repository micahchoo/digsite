-- Storage quotas per group (storage/quota.ts). used_bytes is a running
-- total of the originals and kept camera sources a group's boards store,
-- each stored object counted once; it moves when an object is written or
-- deleted, never by summing a million rows per upload. quota_bytes NULL
-- means the operator's default (GROUP_QUOTA_GB) applies; it is set by
-- scripts/set-group-quota.ts, never by a route.
CREATE TABLE group_storage (
  org_id      text PRIMARY KEY,
  used_bytes  bigint NOT NULL DEFAULT 0,
  quota_bytes bigint
);

-- A folder import that reaches the quota stops, and says why, instead of
-- skipping every file after it. It resumes when started again.
ALTER TABLE folder_imports ADD COLUMN stop_reason text;
ALTER TABLE folder_imports DROP CONSTRAINT folder_imports_state_check;
ALTER TABLE folder_imports ADD CONSTRAINT folder_imports_state_check
  CHECK (state IN ('running', 'done', 'stopped'));
