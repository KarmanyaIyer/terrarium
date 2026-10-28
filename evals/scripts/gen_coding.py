"""Build evals/suites/coding.json from evals/cases/coding/<case>/.

Each case dir holds case.json (title, prompt, optional maxTurns/timeoutSec), workspace/
(written to /workspace) and grader/ (written to /grader, root-owned, hidden from the agent).
Reference solutions live in evals/reference/coding/<case>/ and are never shipped.

Run: python3 -I evals/scripts/gen_coding.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = os.path.join(ROOT, "cases", "coding")
ORDER = [
    "fix-pagination", "fix-roman", "implement-slugify", "implement-lru",
    "parse-duration", "refactor-report", "fix-csv-export", "fix-inventory",
]
COMMAND = "cd /workspace && PYTHONDONTWRITEBYTECODE=1 timeout 120 python3 /grader/test_hidden.py"


def tree(base, mount):
    out = []
    for dirpath, _, names in os.walk(base):
        for n in sorted(names):
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            with open(full, encoding="utf-8") as f:
                out.append({"path": mount + "/" + rel, "content": f.read()})
    return sorted(out, key=lambda f: f["path"])


def main():
    assert sorted(ORDER) == sorted(os.listdir(CASES)), "ORDER out of sync with cases/coding"
    cases = []
    for cid in ORDER:
        d = os.path.join(CASES, cid)
        with open(os.path.join(d, "case.json")) as f:
            meta = json.load(f)
        cases.append({
            "id": cid,
            "title": meta["title"],
            "prompt": meta["prompt"],
            "envType": "vm",
            "setupFiles": tree(os.path.join(d, "workspace"), "/workspace"),
            "hiddenFiles": tree(os.path.join(d, "grader"), "/grader"),
            "check": {"type": "command", "command": COMMAND},
            "maxTurns": meta.get("maxTurns", 20),
            "timeoutSec": meta.get("timeoutSec", 900),
        })
    suite = {
        "id": "coding",
        "title": "Coding with tests",
        "description": "Fix bugs, implement to a spec, refactor; graded by hidden unittest files in the VM.",
        "envType": "vm",
        "cases": cases,
    }
    with open(os.path.join(ROOT, "suites", "coding.json"), "w") as f:
        json.dump(suite, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(len(cases), "coding cases")


if __name__ == "__main__":
    main()
