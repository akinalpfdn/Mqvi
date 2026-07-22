-- Companion thumbnails for chat attachments. Dimensions let the message list reserve layout space
-- before the image loads. Plaintext even for encrypted attachments: a URL and a pixel size are not
-- the secret, and the thumbnail's key travels inside the encrypted payload.

ALTER TABLE attachments ADD COLUMN thumb_url TEXT;
ALTER TABLE attachments ADD COLUMN thumb_width INTEGER;
ALTER TABLE attachments ADD COLUMN thumb_height INTEGER;

ALTER TABLE dm_attachments ADD COLUMN thumb_url TEXT;
ALTER TABLE dm_attachments ADD COLUMN thumb_width INTEGER;
ALTER TABLE dm_attachments ADD COLUMN thumb_height INTEGER;
