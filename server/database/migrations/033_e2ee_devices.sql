-- 033: E2EE cihaz kaydi — Signal Protocol icin device identity ve prekey yonetimi.
--
-- E2EE (End-to-End Encryption) icin her cihaz (browser, Electron) bagimsiz bir
-- kriptografik kimlige sahip olmalidir. Signal Protocol'un X3DH (Extended Triple
-- Diffie-Hellman) akisi soyle calisir:
--
-- 1. Her cihaz kayit olurken bir "prekey bundle" yuklenir:
--    - identity_key: Uzun omurlu Curve25519 public key (cihaz kimligini temsil eder)
--    - signed_prekey: Orta vadeli key, identity_key ile imzalanir (periyodik rotasyon)
--    - one_time_prekeys: Tek kullanimlik ephemeral key'ler (ilk mesajda tuketilir)
--
-- 2. Alice Bob'a ilk mesajini gondermek istediginde:
--    - Bob'un prekey bundle'ini sunucudan ceker
--    - X3DH ile paylasilan gizli anahtar turetir
--    - Double Ratchet ile mesaji sifreler
--    - Sunucu sifrelenmis blob'u depolar, icerigini ASLA goremez
--
-- 3. Tek kullanimlik prekey tuketildikten sonra silinir.
--    Havuz azaldiginda sunucu istemciye WS uzerinden bildirim gonderir.

-- ═══════════════════════════════════════════════════════════
-- user_devices: Her kullanicinin bagimsiz cihaz kayitlari.
-- Bir kullanici birden fazla cihazdan girebilir (web + desktop).
-- Her cihaz icin ayri Signal session olusturulur.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS user_devices (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    display_name TEXT,
    identity_key TEXT NOT NULL,
    signed_prekey TEXT NOT NULL,
    signed_prekey_id INTEGER NOT NULL,
    signed_prekey_signature TEXT NOT NULL,
    registration_id INTEGER NOT NULL DEFAULT 0,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user ON user_devices(user_id);

-- ═══════════════════════════════════════════════════════════
-- device_one_time_prekeys: Her cihaz icin tek kullanimlik prekey havuzu.
-- X3DH sirasinda bir tanesi tuketilir (atomik DELETE ... RETURNING).
-- Havuz 10'un altina dustugunde sunucu istemciye "prekey_low" WS event'i gonderir.
-- ═══════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS device_one_time_prekeys (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    device_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    prekey_id INTEGER NOT NULL,
    public_key TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id, prekey_id),
    FOREIGN KEY (user_id, device_id) REFERENCES user_devices(user_id, device_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_otp_device ON device_one_time_prekeys(user_id, device_id);
