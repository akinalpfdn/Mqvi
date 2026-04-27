-- 014_view_channel.sql
-- Adds the PermViewChannel (bit 4096) permission to all existing roles.
-- This permission controls channel visibility — when denied, the channel is hidden from the sidebar.
-- All existing roles should be able to view channels by default.
UPDATE roles SET permissions = permissions | 4096;
