-- 042: Role mentions support
-- 1. Rename default role "Member" → "everyone"
-- 2. Add mentionable column to roles (default true)
-- 3. Create message_role_mentions table

-- Rename existing default roles
UPDATE roles SET name = 'everyone' WHERE is_default = 1 AND name = 'Member';

-- Add mentionable flag (all existing roles default to mentionable)
ALTER TABLE roles ADD COLUMN mentionable INTEGER NOT NULL DEFAULT 1;

-- Role mentions per message (which roles were @mentioned)
CREATE TABLE IF NOT EXISTS message_role_mentions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    role_id    TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_msg_role_mentions_role ON message_role_mentions(role_id);
