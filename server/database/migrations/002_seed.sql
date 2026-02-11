-- 002_seed.sql
-- Varsayılan sunucu ve roller.
-- Uygulama ilk çalıştığında bu veriler oluşturulur.

-- Varsayılan sunucu
INSERT OR IGNORE INTO server (id, name) VALUES ('default', 'mqvi Server');

-- Varsayılan roller:
-- Owner: tüm yetkiler (512 = ADMIN bit), position en yüksek
-- Admin: tüm yetkiler (512), position 3
-- Moderator: mesaj/kanal yönetimi (1+4+16+32+64+128+256 = 501), position 2
-- Member: temel yetkiler (32+64+128 = 224), position 1
INSERT OR IGNORE INTO roles (id, name, color, position, permissions, is_default) VALUES
    ('owner',     'Owner',     '#E74C3C', 4, 1023, 0),
    ('admin',     'Admin',     '#E91E63', 3, 1023, 0),
    ('moderator', 'Moderator', '#2ECC71', 2, 501,  0),
    ('member',    'Member',    '#99AAB5', 1, 224,  1);

-- Varsayılan kategoriler
INSERT OR IGNORE INTO categories (id, name, position) VALUES
    ('text-channels',  'Text Channels',  0),
    ('voice-channels', 'Voice Channels', 1);

-- Varsayılan kanallar
INSERT OR IGNORE INTO channels (id, name, type, category_id, position) VALUES
    ('general',       'general',       'text',  'text-channels',  0),
    ('voice-general', 'General Voice',  'voice', 'voice-channels', 0);
