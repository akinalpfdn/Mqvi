-- 030_reports.sql
-- Kullanıcı raporlama sistemi.
-- Predefined reason + zorunlu açıklama ile rapor oluşturulur.
-- Admin panelinden raporlar yönetilir (status: pending → reviewed → resolved/dismissed).

CREATE TABLE IF NOT EXISTS reports (
    id               TEXT PRIMARY KEY,
    reporter_id      TEXT NOT NULL,
    reported_user_id TEXT NOT NULL,
    reason           TEXT NOT NULL,
    description      TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    resolved_by      TEXT,
    resolved_at      TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (reporter_id) REFERENCES users(id),
    FOREIGN KEY (reported_user_id) REFERENCES users(id),
    FOREIGN KEY (resolved_by) REFERENCES users(id)
);
