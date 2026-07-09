-- 072_owner_role_mentionable.sql
-- Owner roles were created in Go without setting mentionable, so they stored 0 even though
-- the column defaults to 1. Make every existing owner role mentionable so members can
-- @mention the owner. New servers set mentionable=true at creation.

UPDATE roles SET mentionable = 1 WHERE is_owner = 1;
