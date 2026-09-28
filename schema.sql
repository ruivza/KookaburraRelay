CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS configuration(id INTEGER PRIMARY KEY CHECK(id=1),secret TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,name TEXT NOT NULL,enabled INTEGER NOT NULL,revision TEXT NOT NULL,secret TEXT);
CREATE TABLE IF NOT EXISTS app_channels(app_id TEXT NOT NULL,kind TEXT NOT NULL,enabled INTEGER NOT NULL,secret TEXT NOT NULL,PRIMARY KEY(app_id,kind));
CREATE TABLE IF NOT EXISTS registrations(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,server_id TEXT NOT NULL,token TEXT NOT NULL,token_hash TEXT NOT NULL,environment TEXT NOT NULL,nonce TEXT NOT NULL,challenge_hash TEXT,expires BIGINT NOT NULL,delivery_hash TEXT UNIQUE,revoke_hash TEXT UNIQUE,credentials TEXT,last_sent BIGINT NOT NULL DEFAULT 0,app_id TEXT NOT NULL DEFAULT 'perch-mail',channel TEXT NOT NULL DEFAULT 'apns',app_revision TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY,start BIGINT NOT NULL,count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS abuse_settings(id INTEGER PRIMARY KEY CHECK(id=1),settings JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS abuse_quotas(key TEXT PRIMARY KEY,start BIGINT NOT NULL,expires BIGINT NOT NULL,count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS abuse_quota_expiry ON abuse_quotas(expires);
CREATE INDEX IF NOT EXISTS registration_pending ON registrations(app_id,expires) WHERE delivery_hash IS NULL;
CREATE TABLE IF NOT EXISTS delivery_jobs(id TEXT PRIMARY KEY,registration_id TEXT NOT NULL,app_id TEXT NOT NULL,channel TEXT NOT NULL,device_id TEXT NOT NULL,mode TEXT NOT NULL,dedupe TEXT UNIQUE,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,created BIGINT NOT NULL,updated BIGINT NOT NULL,next_at BIGINT NOT NULL,expires BIGINT NOT NULL,status INTEGER NOT NULL DEFAULT 0,reason TEXT NOT NULL DEFAULT '',duration BIGINT NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS delivery_due ON delivery_jobs(state,next_at);
CREATE INDEX IF NOT EXISTS delivery_app ON delivery_jobs(app_id,created);
CREATE TABLE IF NOT EXISTS gateway_logs(id BIGSERIAL PRIMARY KEY,time BIGINT NOT NULL,kind TEXT NOT NULL,action TEXT NOT NULL,app_id TEXT NOT NULL DEFAULT '',channel TEXT NOT NULL DEFAULT '',status INTEGER NOT NULL,duration BIGINT NOT NULL,request_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS gateway_log_time ON gateway_logs(time);
CREATE TABLE IF NOT EXISTS gateway_runs(id TEXT PRIMARY KEY,started BIGINT NOT NULL,heartbeat BIGINT NOT NULL,stopped BIGINT);
CREATE TABLE IF NOT EXISTS gateway_samples(time BIGINT PRIMARY KEY,rss BIGINT NOT NULL,heap BIGINT NOT NULL,requests BIGINT NOT NULL,errors BIGINT NOT NULL,latency DOUBLE PRECISION NOT NULL,queued BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS gateway_probes(monitor TEXT NOT NULL,time BIGINT NOT NULL,ok INTEGER NOT NULL,latency INTEGER NOT NULL,PRIMARY KEY(monitor,time));
CREATE TABLE IF NOT EXISTS admin_security(id INTEGER PRIMARY KEY CHECK(id=1),token_hash TEXT NOT NULL,totp_secret TEXT,last_step BIGINT NOT NULL DEFAULT -1,pending_secret TEXT,pending_until BIGINT,recovery_hashes JSONB NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS admin_sessions(hash TEXT PRIMARY KEY,expires BIGINT NOT NULL);
INSERT INTO schema_migrations VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS maintenance_settings(id INTEGER PRIMARY KEY CHECK(id=1),settings JSONB NOT NULL,next_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS maintenance_runs(id TEXT PRIMARY KEY,started BIGINT NOT NULL,finished BIGINT,source TEXT NOT NULL,status TEXT NOT NULL,deleted JSONB NOT NULL DEFAULT '{}',error TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS maintenance_previews(id TEXT PRIMARY KEY,expires BIGINT NOT NULL,payload JSONB NOT NULL);
CREATE INDEX IF NOT EXISTS delivery_cleanup ON delivery_jobs(updated) WHERE state NOT IN ('queued','retrying','sending');
CREATE INDEX IF NOT EXISTS registration_expiry ON registrations(expires);
CREATE INDEX IF NOT EXISTS session_expiry ON admin_sessions(expires);
CREATE INDEX IF NOT EXISTS limit_expiry ON limits(start);
CREATE TABLE IF NOT EXISTS gateway_key_check(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backup_settings(id INTEGER PRIMARY KEY CHECK(id=1),settings JSONB NOT NULL,secret TEXT,next_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS backup_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,state TEXT NOT NULL,created BIGINT NOT NULL,started BIGINT,finished BIGINT,next_at BIGINT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,config_revision TEXT NOT NULL,local_file TEXT,local_status TEXT NOT NULL DEFAULT 'pending',local_completed BIGINT,remote_key TEXT,remote_status TEXT NOT NULL DEFAULT 'disabled',bytes BIGINT NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS backup_jobs_due ON backup_jobs(state,next_at);
CREATE TABLE IF NOT EXISTS backup_worker(id INTEGER PRIMARY KEY CHECK(id=1),heartbeat BIGINT NOT NULL);

ALTER TABLE backup_jobs ADD COLUMN IF NOT EXISTS remote_version TEXT;

CREATE TABLE IF NOT EXISTS gateway_queue_samples(time BIGINT PRIMARY KEY,queued BIGINT NOT NULL,retrying BIGINT NOT NULL,sending BIGINT NOT NULL,oldest_wait_seconds DOUBLE PRECISION NOT NULL);
CREATE INDEX IF NOT EXISTS delivery_result_time ON delivery_jobs(updated) WHERE state IN ('accepted','failed','unknown');

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'sync';
ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'sync';
ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS notification TEXT;
ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS notification_hash TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS application_notifications(app_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,settings JSONB NOT NULL);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS kinds JSONB NOT NULL DEFAULT '["sync"]';
ALTER TABLE delivery_jobs ADD COLUMN IF NOT EXISTS notification_sealed INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS application_quotas(app_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,settings JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS access_policies(app_id TEXT PRIMARY KEY REFERENCES applications(id) ON DELETE CASCADE,settings JSONB NOT NULL,revision TEXT NOT NULL,google_secret TEXT);
CREATE TABLE IF NOT EXISTS trusted_servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL,credential_hash TEXT UNIQUE,apps JSONB NOT NULL,revision TEXT NOT NULL,created BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS server_tickets(hash TEXT PRIMARY KEY,server_id TEXT NOT NULL,app_id TEXT NOT NULL,device_id TEXT NOT NULL,revision TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS server_ticket_expiry ON server_tickets(expires);
CREATE TABLE IF NOT EXISTS integrity_challenges(id TEXT PRIMARY KEY,app_id TEXT NOT NULL,channel TEXT NOT NULL,binding TEXT NOT NULL,payload TEXT NOT NULL,revision TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS integrity_challenge_expiry ON integrity_challenges(expires);
CREATE TABLE IF NOT EXISTS integrity_keys(app_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,key_id TEXT NOT NULL,public_key TEXT NOT NULL,counter BIGINT NOT NULL,revision TEXT NOT NULL,expires BIGINT NOT NULL,PRIMARY KEY(app_id,key_id));
CREATE INDEX IF NOT EXISTS integrity_key_expiry ON integrity_keys(expires);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS trusted_server TEXT;
CREATE TABLE IF NOT EXISTS abuse_events(time BIGINT NOT NULL,reason TEXT NOT NULL,count BIGINT NOT NULL,PRIMARY KEY(time,reason));
CREATE TABLE IF NOT EXISTS alert_settings(id INTEGER PRIMARY KEY CHECK(id=1),settings JSONB NOT NULL,secret TEXT,revision TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_incidents(kind TEXT PRIMARY KEY,active INTEGER NOT NULL,last_queued BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_notifications(id TEXT PRIMARY KEY,created BIGINT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,payload JSONB NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at BIGINT NOT NULL,revision TEXT NOT NULL,error TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS alert_notification_due ON alert_notifications(state,next_at);

-- Admission and revocation touch only outstanding work for one registration.
CREATE INDEX IF NOT EXISTS delivery_registration_active ON delivery_jobs(registration_id)
  WHERE state IN ('queued','retrying','sending');

-- Dashboard day totals and latest jobs span all applications.
CREATE INDEX IF NOT EXISTS delivery_created ON delivery_jobs(created DESC);
