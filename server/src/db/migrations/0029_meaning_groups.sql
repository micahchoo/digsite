-- Incremental arrangement and sections for the meaning sort
-- (meaning/arrangement.ts). A position becomes a double, so a new picture
-- can be placed between two others without renumbering the board; a full
-- arrangement makes them whole numbers again. meaning_group is the
-- arrangement's group (a run of the map, about 1/16 of it), and
-- meaning_groups names each: the board's best label term for it, or NULL
-- for "Group n".
ALTER TABLE images ALTER COLUMN meaning_pos TYPE double precision;
ALTER TABLE images ADD COLUMN meaning_group integer;
CREATE TABLE meaning_groups (
  board_id uuid NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  grp      integer NOT NULL,
  label    text,
  PRIMARY KEY (board_id, grp)
);

-- An incremental placement asks for the next position after its
-- neighbour's; without this it scans the board once per new picture.
CREATE INDEX images_board_meaning_pos ON images (board_id, meaning_pos)
  WHERE meaning_pos IS NOT NULL;
