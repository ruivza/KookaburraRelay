-- Console listings filter logs by kind or application and tasks by state, newest first, and count the matches.
CREATE INDEX IF NOT EXISTS gateway_log_kind_time ON gateway_logs(kind,time);
CREATE INDEX IF NOT EXISTS gateway_log_app_time ON gateway_logs(app_id,time);
CREATE INDEX IF NOT EXISTS delivery_state_created ON delivery_jobs(state,created);
