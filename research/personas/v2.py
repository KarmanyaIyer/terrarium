"""Runs gd_grid with the second-pass persona texts."""
import os, runpy, sys
os.environ["PERSONA_TEXTS"] = "persona_texts_v2.jsonl"
sys.argv = ["gd_grid.py"] + sys.argv[1:]
runpy.run_path("gd_grid.py", run_name="__main__")
