-- v0.2: attachments (photos, videos, PDFs, voice...). Run once on a database created from the v0.1 schema:
--   npx wrangler d1 execute oh-my-bot --remote --file migrations/0002_attachments.sql
ALTER TABLE messages ADD COLUMN attachments TEXT;
ALTER TABLE messages ADD COLUMN media_group TEXT;
CREATE INDEX IF NOT EXISTS messages_group ON messages (room, media_group);
