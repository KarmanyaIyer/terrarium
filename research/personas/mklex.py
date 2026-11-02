"""Adds a single-neuron persona: theme in lex_themes.json, spec, catalog entry, queue line at the head of a lane.
Usage: mklex.py <lane> <id> <ref like L22N9118> <dose> <name> <group> <trait> <regex> [blurb]"""
import json
import os
import re
import subprocess
import sys

lane, tid, ref, dose, name, group, trait, rx = sys.argv[1:9]
blurb = sys.argv[9] if len(sys.argv) > 9 else ""
dose = float(dose)
L, n = map(int, re.fullmatch(r"L(\d+)N(\d+)", ref).groups())
p = "lex_themes.json"
d = json.load(open(p)) if os.path.exists(p) else {}
d[tid] = {"group": group, "trait": trait, "words": rx}
json.dump(d, open(p, "w"), indent=1, ensure_ascii=False)
LFM = os.environ.get("LFM")
hn = ("lfm-" if LFM else "") + f"lex-{tid}-{dose:+.2f}"
json.dump({"name": hn, "theme": tid, **({"model": "LFM3"} if LFM else {}), "description": f"single neuron {ref} at {dose:+.2f}", "pushes": [{"layer": L, "neuron": n, "mode": "dose", "value": dose}]}, open(f"specs/{hn}.json", "w"))
c = json.load(open("catalog.json"))
c[hn] = {"name": name, "blurb": blurb or f"One neuron, {ref}{dose:+.2f}. {trait.capitalize()}. Runs in the app today.", "group": group, **({"model": "LFM3-1.7B-MLX-8bit", "settings": {"stop": ["</think>"]}} if LFM else {})}
json.dump(c, open("catalog.json", "w"), indent=1, ensure_ascii=False)
open(f"/tmp/q_{hn}.txt", "w").write(("P_MODEL=/Users/karvi/PRIMARY/Projects/terrarium/models/LFM3-1.7B-MLX-8bit " if LFM else "") + f"heldout.py {hn} specs/{hn}.json\n")
subprocess.call([sys.executable, "addq.py", lane, f"/tmp/q_{hn}.txt"])
print(hn)
