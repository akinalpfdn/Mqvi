-- 035: E2EE grup oturum takibi + sifreli anahtar yedegi.
--
-- channel_group_sessions: Megolm/Sender Key grup oturumlarini takip eder.
-- Her kanal icin her gonderici cihaz bir "outbound session" olusturur.
-- Diger uyeler bu session'in "inbound" kopyasini alarak mesajlari cozer.
-- session_data sunucuda opak blob olarak saklanir — sunucu okuyamaz.
--
-- e2ee_key_backups: Kullanicinin opsiyonel anahtar yedegi.
-- Recovery password ile sifrelenmis blob. Sunucu sifresini bilmez.
-- Yeni cihazda recovery password girilirse tum anahtar gecmisi yuklenebilir.

-- ═══════════════════════════════════════════════════════════
-- channel_group_sessions: Kanal bazli Sender Key oturumlari.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS channel_group_sessions (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender_device_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_data TEXT NOT NULL,
    message_index INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, sender_user_id, sender_device_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_cgs_channel ON channel_group_sessions(channel_id);
CREATE INDEX IF NOT EXISTS idx_cgs_sender ON channel_group_sessions(sender_user_id, sender_device_id);

-- ═══════════════════════════════════════════════════════════
-- e2ee_key_backups: Sifreli anahtar yedegi (kullanici basina tek kayit).
--
-- algorithm: Sifreleme algoritmasi (varsayilan aes-256-gcm)
-- encrypted_data: Base64 ciphertext (tum anahtarlar — identity, signed prekey,
--                 Signal sessions, Sender Key sessions, guvenilen kimlikler)
-- nonce: Base64 AES-GCM nonce (12 byte)
-- salt: Base64 PBKDF2 tuzu (32 byte) — recovery password'den anahtar turetmek icin
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS e2ee_key_backups (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
    encrypted_data TEXT NOT NULL,
    nonce TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id)
);
