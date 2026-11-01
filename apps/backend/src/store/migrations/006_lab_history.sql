-- Neuron Lab: results kept with the exact recipe they ran with. data_json is the UI's record of the run.
CREATE TABLE lab_history (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  model_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX lab_history_model ON lab_history (model_id, created_at);
