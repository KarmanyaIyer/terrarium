-- Terrarium trace store, schema v1. Blobs live in data/blobs/<sha256[0:2]>/<sha256>.

CREATE TABLE envs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('vm', 'sim')),
  status TEXT NOT NULL,
  status_detail TEXT,
  network TEXT NOT NULL DEFAULT 'off',
  parent_env_id TEXT,
  base_snapshot_id TEXT,
  factory_snapshot_id TEXT,
  config_json TEXT NOT NULL,
  facts_json TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 0, -- storage destroyed (ephemeral eval forks); trace data stays
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  env_id TEXT NOT NULL,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('factory', 'manual', 'auto')),
  bytes INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX snapshots_env ON snapshots (env_id, created_at);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  env_id TEXT,
  title TEXT NOT NULL,
  model_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  thinking INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  status TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  eval_run_id TEXT,
  eval_case_id TEXT,
  ephemeral INTEGER NOT NULL DEFAULT 0,
  context_json TEXT,
  transcript_blob TEXT, -- agent message array (JSON) after the last run, for resume after restart
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_env ON sessions (env_id);
CREATE INDEX sessions_eval ON sessions (eval_run_id);

CREATE TABLE events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) WITHOUT ROWID;

CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  request_blob TEXT,
  response_blob TEXT,
  raw_blob TEXT,
  finish_reason TEXT,
  usage_json TEXT,
  timing_json TEXT,
  context_window INTEGER,
  max_tokens INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX model_calls_session ON model_calls (session_id, seq);

CREATE TABLE manifests (
  env_id TEXT NOT NULL,
  session_id TEXT,
  seq INTEGER NOT NULL,
  blob TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX manifests_session ON manifests (session_id, seq);
CREATE INDEX manifests_env ON manifests (env_id, created_at);

CREATE TABLE net_log (
  id TEXT PRIMARY KEY,
  env_id TEXT NOT NULL,
  session_id TEXT,
  ts INTEGER NOT NULL,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  ip TEXT,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  status INTEGER,
  bytes_in INTEGER,
  bytes_out INTEGER
);
CREATE INDEX net_log_env ON net_log (env_id, ts);
CREATE INDEX net_log_session ON net_log (session_id);

CREATE TABLE user_exec (
  id TEXT PRIMARY KEY,
  env_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  as_user TEXT NOT NULL,
  command TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  stdout_blob TEXT,
  stderr_blob TEXT
);
CREATE INDEX user_exec_env ON user_exec (env_id, ts);

CREATE TABLE eval_runs (
  id TEXT PRIMARY KEY,
  suite_id TEXT NOT NULL,
  suite_title TEXT NOT NULL,
  config_json TEXT NOT NULL,
  cases_json TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE eval_results (
  run_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  env_id TEXT,
  duration_ms INTEGER,
  tokens_json TEXT,
  detail TEXT,
  score REAL,
  PRIMARY KEY (run_id, case_id, model_id)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
