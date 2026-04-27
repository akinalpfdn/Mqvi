-- 035: E2EE group session tracking + encrypted key backup.
--
-- channel_group_sessions: Tracks Megolm/Sender Key group sessions.
-- Each sender device creates an "outbound session" for each channel.
-- Other members receive the "inbound" copy of that session to decrypt messages.
-- session_data is stored on the server as an opaque blob — the server cannot read it.
--
-- e2ee_key_backups: The user's optional key backup.
-- A blob encrypted with the recovery password. The server does not know the password.
-- On a new device, entering the recovery password lets the entire key history be loaded.

-- ═══════════════════════════════════════════════════════════
-- channel_group_sessions: Per-channel Sender Key sessions.
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
-- e2ee_key_backups: Encrypted key backup (one record per user).
--
-- algorithm: Encryption algorithm (default aes-256-gcm)
-- encrypted_data: Base64 ciphertext (all keys — identity, signed prekey,
--                 Signal sessions, Sender Key sessions, trusted identities)
-- nonce: Base64 AES-GCM nonce (12 bytes)
-- salt: Base64 PBKDF2 salt (32 bytes) — used to derive a key from the recovery password
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
