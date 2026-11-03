-- Removed in 0.3.0. Rate limits are counted in memory since 0.2.0; applications.secret duplicated the sealed APNs
-- key that app_channels holds and has been cleared since 0.1.3; configuration predates per-application channels and
-- has not been read since.
DROP TABLE IF EXISTS limits;
DROP TABLE IF EXISTS configuration;
ALTER TABLE applications DROP COLUMN IF EXISTS secret;
