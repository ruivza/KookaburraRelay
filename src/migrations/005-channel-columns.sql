-- Channel identifiers in plain columns, so listing and uniqueness checks never decrypt; secret keeps only the
-- private key. The gateway converts rows written by earlier versions at startup (ChannelStore.backfill).
ALTER TABLE app_channels ADD COLUMN IF NOT EXISTS key_id TEXT;
ALTER TABLE app_channels ADD COLUMN IF NOT EXISTS team_id TEXT;
ALTER TABLE app_channels ADD COLUMN IF NOT EXISTS topic TEXT;
ALTER TABLE app_channels ADD COLUMN IF NOT EXISTS environment TEXT;
ALTER TABLE app_channels ADD COLUMN IF NOT EXISTS project_id TEXT;
ALTER TABLE app_channels ADD COLUMN IF NOT EXISTS client_email TEXT;
CREATE INDEX IF NOT EXISTS app_channel_topic ON app_channels(team_id,topic) WHERE kind='apns';
CREATE INDEX IF NOT EXISTS app_channel_project ON app_channels(project_id) WHERE kind='fcm';
