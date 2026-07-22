-- Stored byte size of a companion thumbnail.
--
-- Thumbnails were stored without being charged to the uploader's quota, which made them an
-- unmetered store: a client could send trivial files with large "thumbnails" and pay nothing.
-- The quota is a running counter, so charging them at upload means the delete path has to know
-- how much to give back — hence this column.

ALTER TABLE attachments ADD COLUMN thumb_size INTEGER;
ALTER TABLE dm_attachments ADD COLUMN thumb_size INTEGER;
