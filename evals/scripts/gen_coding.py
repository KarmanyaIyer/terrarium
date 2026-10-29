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
# Graded by the VM's test grader (guest/files/usr/local/libexec/terrarium/grade.py): candidate code and the
# hidden tests run in separate processes and uids, and the case passes only when every counted test passed.
CHECK = {"type": "tests", "file": "/grader/test_hidden.py", "timeoutSec": 120}


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
            "check": dict(CHECK),
            "maxTurns": meta.get("maxTurns", 20),
            "timeoutSec": meta.get("timeoutSec", 900),
        })
    suite = {
        "id": "coding",
        "title": "Coding with tests",
        "description": "Fix bugs, implement to a spec, refactor; graded by hidden unittest files in the VM (candidate code and tests in separate processes).",
        "envType": "vm",
        "cases": cases,
    }
    with open(os.path.join(ROOT, "suites", "coding.json"), "w") as f:
        json.dump(suite, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(len(cases), "coding cases")


if __name__ == "__main__":
    main()
