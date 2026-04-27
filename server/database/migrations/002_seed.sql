-- 002_seed.sql
-- Default server and roles.
-- These records are created when the application first starts.

-- Default server
INSERT OR IGNORE INTO server (id, name) VALUES ('default', 'mqvi Server');

-- Default roles:
-- Owner: all permissions (512=ADMIN + ViewChannel=4096), highest position
-- Admin: all permissions, position 3
-- Moderator: message/channel management + ViewChannel (1+4+16+32+64+128+256+4096 = 4597), position 2
-- Member: basic permissions + ViewChannel (32+64+128+4096 = 4320), position 1
INSERT OR IGNORE INTO roles (id, name, color, position, permissions, is_default) VALUES
    ('owner',     'Owner',     '#E74C3C', 4, 5119, 0),
    ('admin',     'Admin',     '#E91E63', 3, 5119, 0),
    ('moderator', 'Moderator', '#2ECC71', 2, 4597, 0),
    ('member',    'Member',    '#99AAB5', 1, 4320, 1);

-- Default categories
INSERT OR IGNORE INTO categories (id, name, position) VALUES
    ('text-channels',  'Text Channels',  0),
    ('voice-channels', 'Voice Channels', 1);

-- Default channels
INSERT OR IGNORE INTO channels (id, name, type, category_id, position) VALUES
    ('general',       'general',       'text',  'text-channels',  0),
    ('voice-general', 'General Voice',  'voice', 'voice-channels', 0);
