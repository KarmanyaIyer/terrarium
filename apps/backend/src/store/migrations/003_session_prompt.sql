-- Per-session system prompt override (null: the harness profile's prompt).
ALTER TABLE sessions ADD COLUMN system_prompt TEXT;
