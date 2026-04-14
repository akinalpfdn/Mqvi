-- 055: Clean up orphan user_roles rows where the user is no longer a member
-- of the role's server.
--
-- Background: prior to this migration, leaving or being kicked from a server
-- only deleted the server_members row; user_roles rows persisted. This let
-- allowedViewers() still resolve permissions for the former member and keep
-- broadcasting channel events to them.
--
-- This migration removes those orphans. New leave/kick operations now clean
-- up user_roles synchronously (see sqliteServerRepo.RemoveMember).

DELETE FROM user_roles
WHERE NOT EXISTS (
    SELECT 1
    FROM server_members sm
    WHERE sm.user_id = user_roles.user_id
      AND sm.server_id = user_roles.server_id
);
