-- 011_reply_to.sql
-- Reply (yanıt) sistemi: mesajlar başka bir mesaja yanıt olarak gönderilebilir.
--
-- reply_to_id NULL → normal mesaj
-- reply_to_id dolu → yanıt mesajı (referans mesajın ID'si)
--
-- FK constraint KULLANILMIYOR: Referans mesaj silindiğinde reply_to_id korunur.
-- LEFT JOIN ile referans mesaj sorgulanır:
--   - reply_to_id NOT NULL, JOIN sonucu var → tam referans göster
--   - reply_to_id NOT NULL, JOIN sonucu NULL → "Orijinal mesaj silindi" göster
--   - reply_to_id NULL → yanıt değil, referans gösterme
--
-- Bu yaklaşım Discord'un davranışını taklit eder: silinen mesaja verilen
-- yanıtlarda "Original message was deleted" görüntülenir.

ALTER TABLE messages ADD COLUMN reply_to_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id);
