-- How a strain generates in chats and evals (LabStrainSettings). NULL on older rows: the defaults for their pushes.
ALTER TABLE lab_strains ADD COLUMN settings_json TEXT;
