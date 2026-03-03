-- Report attachments — rapor delili olarak eklenen dosyalar (sadece resimler).
-- Mevcut attachments / dm_attachments tabloları ile paralel yapı.
-- FK: reports(id) CASCADE — rapor silinince ekleri de silinir.
CREATE TABLE IF NOT EXISTS report_attachments (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    file_url TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
