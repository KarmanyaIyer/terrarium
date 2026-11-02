"""sparse_run with a seed, for lanes whose runner predates env prefixes. seeded.py <seed> <sparse_run args>"""
import os, runpy, sys
os.environ["P_SEED"] = sys.argv[1]
sys.argv = ["sparse_run.py"] + sys.argv[2:]
runpy.run_path("sparse_run.py", run_name="__main__")
