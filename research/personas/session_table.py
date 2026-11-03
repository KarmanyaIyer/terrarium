"""Merges the Opus sample of session runs (qa9) and writes the session table into FINDINGS.md and results/session_runs.json.
Each specimen: as stored, at repeat 1.1 where run, with the old system prompt, and the first held-out number."""
import json
import re

from common import read_jsonl
from session_judge import G, persona


def wilson_low(p, n, z=1.96):
    d = 1 + z * z / n
    return (p + z * z / (2 * n) - z * ((p * (1 - p) + z * z / (4 * n)) / n) ** 0.5) / d


# Opus sample: two parts, ids restart in each
opus = {}
agree = [0, 0]
decoy = [0, 0]
for part in (0, 1):
    key = {r["id"]: r for r in read_jsonl(f".cache/judge/qa9.{part}.key.jsonl")}
    for v in json.load(open(f".cache/judge/qa9.{part}.out.json")):
        k = key[v["id"]]
        if k["name"] == "baseline":
            decoy[0] += int(v["concept"])
            decoy[1] += 1
            continue
        d = opus.setdefault(k["name"], [0, 0])
        j = int(v["concept"]) * int(v["coherent"])
        d[0] += j
        d[1] += 1
        agree[0] += j == k["concept"] * k["coherent"]
        agree[1] += 1
print("Opus agreement", agree, "decoys", decoy)

J = {}
for b in ("ho47", "ho48", "ho49", "ho50", "ho51", "ho52"):
    for r in read_jsonl(f".cache/judge/{b}.judged.jsonl"):
        if "concept" in r:
            J.setdefault(r["name"], []).append(r)


def stat(name):
    rs = J.get(name)
    if not rs:
        return None
    n = len(rs)
    assert n == 48, (name, n)
    j = sum(r["concept"] * r["coherent"] for r in rs) / n
    out = {"run": name, "n": n, "concept": round(sum(r["concept"] for r in rs) / n, 3), "coherent": round(sum(r["coherent"] for r in rs) / n, 3), "joint": round(j, 3), "joint_wilson95_low": round(wilson_low(j, n), 3)}
    if name in opus:
        out["opus_joint"] = round(opus[name][0] / opus[name][1], 3)
        out["opus_n"] = opus[name][1]
    rows = read_jsonl(f"results/heldout/{name}.jsonl")
    out["ran_to_cap"] = sum((r.get("tokens") or 0) >= 295 for r in rows)
    return out


table = {}
for sp in G:
    i = sp["id"]
    p = persona(sp)
    stored = stat(f"session-{i}")
    r11 = stat(f"session-{i}-r1.1")
    best_repeat = sp["settings"]["repeat"]
    if r11 and stored and r11["joint"] >= stored["joint"] + 0.05:
        best_repeat = 1.1
    table[i] = {"name": sp["name"], "model": sp["modelId"], "heldout_run": p["heldout_run"], "kind": "vector" if sp["mix"][0].get("kind") == "vector" else f"{len(sp['mix'])} neuron" + ("s" if len(sp["mix"]) > 1 else ""), "stored_repeat": sp["settings"]["repeat"], "chat": stored, "chat_repeat_1_1": r11, "chat_repeat_chosen": best_repeat, "with_system_prompt": stat(f"withprompt-session-{i}"), "compare_joint": p["numbers"]["joint"]}
json.dump({"settings": "lab_serve.chat_completion, no system prompt, thinking off, stop tokens, temperature 0.7, top_p 0.95, 300 tokens, N=48", "opus": {"agreement": agree, "decoys": decoy}, "specimens": table}, open("results/session_runs.json", "w"), indent=1)


def pc(s, key="joint"):
    return "" if not s else f"{s[key] * 100:.0f}"


def op(s):
    return "" if not s or "opus_joint" not in s else f" / {s['opus_joint'] * 100:.0f}"


rows = sorted(table.values(), key=lambda t: (-max(t["chat"]["joint"], t["chat_repeat_1_1"]["joint"] if t["chat_repeat_1_1"] else 0)))
L = ["| Name | Model | Kind | Chat as stored | Chat at repeat 1.1 | Repeat to use | With the old system prompt | Compare, first held-out |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
short = {"Qwen3.5-4B-MLX-4bit": "Qwen 4B", "Qwen3.5-9B-MLX-4bit": "Qwen 9B", "LFM3-1.7B-MLX-8bit": "LFM3"}
for t in rows:
    L.append(f"| {t['name']} | {short[t['model']]} | {t['kind']} | {pc(t['chat'])}{op(t['chat'])} | {pc(t['chat_repeat_1_1'])}{op(t['chat_repeat_1_1'])} | {t['chat_repeat_chosen'] or 'off'} | {pc(t['with_system_prompt'])} | {t['compare_joint'] * 100:.0f} |")
s = open("FINDINGS.md").read()
s = re.sub(r"<!-- session -->.*<!-- /session -->", lambda m: "<!-- session -->\n" + "\n".join(L) + "\n<!-- /session -->", s, flags=re.S)
open("FINDINGS.md", "w").write(s)
print("\n".join(L))
print("--- Opus against Haiku")
for n, (a, b) in sorted(opus.items()):
    print(n, a, "/", b, "Haiku", stat(n)["joint"])
