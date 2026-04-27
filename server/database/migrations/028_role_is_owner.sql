-- 028_role_is_owner.sql
-- Identify the owner role by an is_owner flag instead of by ID.
--
-- Problem: The default server's owner role was created with the ID 'owner',
-- but owner roles in newly created servers receive random IDs.
-- All owner checks (HasOwnerRole, role_service, frontend) compared role.ID == "owner",
-- which failed for those new servers.
--
-- Solution: Add an is_owner column. It identifies the owner role
-- independently of its ID.

ALTER TABLE roles ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;

-- Flag the existing role with ID "owner" (default server's owner role)
UPDATE roles SET is_owner = 1 WHERE id = 'owner';

-- Flag owner roles in newly created servers as well.
-- Owner role: PermAll ((1<<16)-1 = 65535) and position >= 100
UPDATE roles SET is_owner = 1
WHERE permissions = 65535 AND position >= 100 AND is_owner = 0;
