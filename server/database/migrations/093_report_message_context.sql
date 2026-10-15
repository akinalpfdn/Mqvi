-- Message-level reports: which message was flagged, plus a client-supplied
-- snapshot of its text (the message may be edited/deleted later, and E2EE DM
-- content is unreadable server-side).
ALTER TABLE reports ADD COLUMN message_id TEXT;
ALTER TABLE reports ADD COLUMN dm_message_id TEXT;
ALTER TABLE reports ADD COLUMN message_excerpt TEXT;
