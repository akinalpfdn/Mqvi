-- 038: LiveKit instance'larina Hetzner Cloud server ID alani eklendi.
--
-- hetzner_server_id: Hetzner Cloud API'de sunucunun numeric ID'si (string olarak).
-- Bos string = Hetzner entegrasyonu yok, yalnizca LiveKit /metrics kullanilir.
-- Bu alan MetricsCollector'in Hetzner API'den CPU ve network metrikleri
-- cekmesi icin gereklidir.

ALTER TABLE livekit_instances ADD COLUMN hetzner_server_id TEXT NOT NULL DEFAULT '';
