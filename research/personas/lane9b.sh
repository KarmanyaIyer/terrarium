#!/bin/zsh
# Waits for other model jobs to end, then runs lane d alone, then restarts lanes a, b, c.
cd "$(dirname "$0")"
while pgrep -f "personas/../../.venv/bin/python (heldout|sparse_run|seeded|v2|persona_gen|gd_grid|evolve|scan_lens)" > /dev/null; do sleep 10; done
../../.venv/bin/python runq.py d
for l in a b c; do nohup ../../.venv/bin/python runq.py $l > /dev/null 2>&1 < /dev/null & done
