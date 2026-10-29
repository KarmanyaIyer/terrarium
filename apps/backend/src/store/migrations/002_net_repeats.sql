-- Identical network decisions in a short window collapse into one row with a count, so a request loop can't
-- grow the log (and the trace) without bound.
ALTER TABLE net_log ADD COLUMN repeats INTEGER NOT NULL DEFAULT 1;
ALTER TABLE net_log ADD COLUMN last_ts INTEGER;
