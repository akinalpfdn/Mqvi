-- 019: Add a position column to server_members.
--
-- Each user can drag-reorder their own server list.
-- The position is per-user — it does not affect other users.
-- Existing rows are assigned positions in joined_at order (0-based).
-- New members are added with MAX(position)+1 (in AddMember).

ALTER TABLE server_members ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

-- Assign positions to existing rows in joined_at order.
-- SQLite does not support UPDATE ... SET = (SELECT ROW_NUMBER()), so we
-- assign sequential values per (user_id, server_id) pair manually.
-- Simple approach: order each user's servers by joined_at and assign
-- positions starting from 0.
--
-- Implemented with a correlated subquery (effectively a CTE):
UPDATE server_members
SET position = (
    SELECT COUNT(*)
    FROM server_members sm2
    WHERE sm2.user_id = server_members.user_id
      AND sm2.joined_at < server_members.joined_at
);
