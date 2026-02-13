-- 007_channel_reads.sql
-- Kanal okuma durumu takibi — okunmamış mesaj badge'i için.
--
-- Her kullanıcı-kanal çifti için son okunan mesaj ID'si tutulur.
-- Bu sayede okunmamış mesaj sayısı = bu ID'den sonraki mesaj sayısı olarak hesaplanır.
--
-- Neden last_read_message_id?
-- Her mesajı "okundu/okunmadı" olarak işaretlemek çok pahalı olurdu.
-- "Bu noktaya kadar okudum" şeklinde watermark tutmak çok daha verimli.

CREATE TABLE IF NOT EXISTS channel_reads (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_message_id TEXT,
    last_read_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel_id)
);
