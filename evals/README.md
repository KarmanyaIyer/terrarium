# Evals

- `suites/*.json`: built suites the app loads (`boundary.json` is maintained separately).
- `datasets.json`: dataset suites (pinned URLs, sha256, licenses, default sample sizes).
- `cases/coding/<case>/`: coding case sources (`workspace/` -> /workspace, `grader/` -> /grader).
- `reference/`: reference solutions and replies. Never shipped into an env.
- `scripts/`: generators and verifiers.

Rebuild and verify after editing a case:

```sh
python3 -I evals/scripts/gen_sim.py       # tool-basics, shell-data
python3 -I evals/scripts/gen_coding.py    # coding
.venv/bin/python -I evals/scripts/gen_none.py   # reasoning, speed (prints speed prompt token counts)
node evals/scripts/verify.ts              # every hand-written case vs its reference
node evals/scripts/verify_datasets.ts     # download datasets, check every converted case
```

`verify.ts` requires each sim/vm check to fail before the reference runs and pass after it.
Coding cases run on the host's python3 with /workspace and /grader rewritten to
`evals/.scratch/`.
