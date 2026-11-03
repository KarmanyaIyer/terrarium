"""Writes the shortlist table into FINDINGS.md: every recipe run on the second held-out, with all its numbers from suite.json."""
import json
import re

S = json.load(open("suite.json"))["personas"]


def pct(x):
    return f"{x * 100:.1f}" if x is not None else ""


def both(d):
    if not d:
        return ""
    o = f" / {round(d['opus_joint'] * 100)}" if d.get("opus_joint") is not None else ""
    return f"{d['joint'] * 100:.1f}{o}"


def chat(p):
    n = p["numbers"]
    if p.get("strain_chat_repeat_chosen") == 1.1 and n.get("strain_chat_repeat_1_1"):
        return both(n["strain_chat_repeat_1_1"]) + " (repeat 1.1)"
    return both(n.get("strain_chat"))


rows = [p for p in S if p["numbers"].get("confirm_fresh_prompts")]


def form(p):
    r = p["recipe"]
    if r["type"] == "residual_vector":
        return f"vector L{r['layer']} x{r['strength']}"
    if r["neurons"] == 1:
        x = r["pushes"][0]
        return f"L{x['layer']}N{x['neuron']}{x['dose']:+g}"
    return f"{r['neurons']} neurons"


def group(p):
    r = p["recipe"]
    m = p["model"]
    a = 2 if r["type"] == "residual_vector" else (1 if r["neurons"] > 1 else 0)
    b = 0 if "4B" in m else (1 if "LFM3" in m else 2)
    return (a, b, -p["numbers"]["confirm_fresh_prompts"]["joint"])


rows.sort(key=group)
L = ["| Name | Model | Recipe | Held-out 1, Haiku / Opus | Held-out 2 (fresh), Haiku / Opus | Strain chat, Haiku / Opus | Named blind | Re-dosed |", "| --- | --- | --- | --- | --- | --- | --- | --- |"]
for p in rows:
    n = p["numbers"]
    o = n.get("opus_recheck")
    first = f"{n['joint'] * 100:.1f}" + (f" / {round(o['opus_joint'] * 100)}" if o else "")
    nb = n.get("named_blind")
    m = p["model"].split("-MLX")[0].replace("Qwen3.5-", "Qwen ").replace("-1.7B", "")
    name = re.sub(r" \((LFM3|9B)[^)]*\)", "", p["name"]).replace(" (generator pick)", "")
    L.append(f"| {name} | {m} | {form(p)} | {first} | {both(n['confirm_fresh_prompts'])} | {chat(p)} | {str(nb['hits']) + '/' + str(nb['n']) if nb else ''} | {'yes' if p['retuned_after_heldout'] else ''} |")
t = "\n".join(L)
s = open("FINDINGS.md").read()
s = re.sub(r"<!-- shortlist -->.*<!-- /shortlist -->", lambda m: "<!-- shortlist -->\n" + t + "\n<!-- /shortlist -->", s, flags=re.S)
open("FINDINGS.md", "w").write(s)
print(t)
