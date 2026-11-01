-- Logical per-session resource use. Counters survive a backend restart and bound unique data even when blobs dedupe.
CREATE TABLE session_budget_usage (
  session_id TEXT PRIMARY KEY,
  trace_bytes INTEGER NOT NULL DEFAULT 0,
  capture_bytes INTEGER NOT NULL DEFAULT 0,
  snapshot_count INTEGER NOT NULL DEFAULT 0,
  network_rows INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  network_bytes INTEGER NOT NULL DEFAULT 0
);
