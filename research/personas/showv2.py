import sys
from common import read_jsonl
for r in read_jsonl("results/dense_grid.jsonl"):
    if r["theme"] in sys.argv[1].split(",") and r["steps"]==41 and r["scale"]==float(sys.argv[2]):
        print(r["theme"],r["scale"],r["concept"],r["coherent"])
        for t,p in list(zip(r["samples"],r["prompts"]))[1::4]: print("  ",repr(t[:int(sys.argv[3])]))
