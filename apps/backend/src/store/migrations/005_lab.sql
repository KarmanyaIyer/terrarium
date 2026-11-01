-- Neuron Lab: saved probe sets (concept vs control texts for the finder) and strains (a base model plus neuron pushes,
-- usable as a model in sessions and evals as strain:<id>). Starter probe sets ship in scripts/lab_sets.json.
CREATE TABLE lab_probe_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  concept_json TEXT NOT NULL,
  control_json TEXT NOT NULL,
  test_prompt TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE lab_strains (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_model_id TEXT NOT NULL,
  pushes_json TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
