-- 028_role_is_owner.sql
-- Owner rolünü ID yerine is_owner flag'i ile tanımlama.
--
-- Problem: Default server'ın owner rolü 'owner' ID'si ile oluşturulmuşken,
-- yeni oluşturulan sunuculardaki owner rolleri rastgele ID alıyor.
-- Tüm owner kontrolleri (HasOwnerRole, role_service, frontend) role.ID == "owner"
-- karşılaştırması yapıyordu ve bu yeni sunucularda çalışmıyordu.
--
-- Çözüm: is_owner kolonu ekleniyor. Bu kolon ID'den bağımsız olarak
-- owner rolünü tanımlar.

ALTER TABLE roles ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0;

-- Mevcut "owner" ID'li rolü işaretle (default server'ın owner rolü)
UPDATE roles SET is_owner = 1 WHERE id = 'owner';

-- Yeni oluşturulmuş sunuculardaki owner rolleri de işaretle.
-- Owner rolü: PermAll ((1<<16)-1 = 65535) ve position >= 100
UPDATE roles SET is_owner = 1
WHERE permissions = 65535 AND position >= 100 AND is_owner = 0;
