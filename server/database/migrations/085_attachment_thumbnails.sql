-- Companion thumbnails for chat attachments.
--
-- The thumbnail is a separately stored file, so it needs its own URL. Dimensions are stored
-- alongside it so the message list can reserve layout space before the image loads instead of
-- reflowing when it arrives.
--
-- These columns stay plaintext for encrypted attachments too: a URL and a pixel size are not the
-- secret, the bytes are. The key material for decrypting a thumbnail travels inside the already
-- encrypted message payload, never through the server.

ALTER TABLE attachments ADD COLUMN thumb_url TEXT;
ALTER TABLE attachments ADD COLUMN thumb_width INTEGER;
ALTER TABLE attachments ADD COLUMN thumb_height INTEGER;

ALTER TABLE dm_attachments ADD COLUMN thumb_url TEXT;
ALTER TABLE dm_attachments ADD COLUMN thumb_width INTEGER;
ALTER TABLE dm_attachments ADD COLUMN thumb_height INTEGER;
