"""Rewrites the table between the markers in FINDINGS.md from suite.json, so the rates are never typed by hand."""
import json, re
s = json.load(open("suite.json"))["personas"]
def row(p):
    n = p["numbers"]; r = p["recipe"]
    kind = ("1 neuron" if r["neurons"] == 1 else f"{r['neurons']} neurons") if r["type"] == "neurons" else f"vector L{r['layer']} x{r['strength']}"
    m = p["model"].split("-MLX")[0].replace("Qwen3.5-", "Qwen ")
    return f"| {p['name']} | {p['group']} | {m} | {kind} | {n['joint']*100:.1f} | {n['joint_wilson95_low']*100:.1f} | {n['concept']*100:.0f} | {n['coherent']*100:.0f} | {n['n']} | {('re-dosed' if p.get('retuned_after_heldout') else '')} | {(str(round(n['confirm_fresh_prompts']['joint']*100, 1)) if n.get('confirm_fresh_prompts') else '')} | {(str(round(n['opus_recheck']['opus_joint']*100)) + ' (N=' + str(n['opus_recheck']['n']) + ')') if n.get('opus_recheck') else ''} |"
head = "| Name | Theme group | Model | Recipe | Joint % | Wilson 95 low | Concept % | Coherent % | N | Tuned on held-out | Fresh-prompt joint % | Opus joint % |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
order = {"keeper": 0, "promising": 1, "failed": 2}
out = []
for st, label in (("keeper", "Keepers (joint at least 80%)"), ("promising", "Promising (60 to 80%, plus keepers overturned by Opus)"), ("failed", "Below 60%")):
    rows = [row(p) for p in s if p["status"] == st]
    out.append(f"**{label}: {len(rows)}**\n\n{head}\n" + "\n".join(rows))
table = "\n\n".join(out)
t = open("FINDINGS.md").read()
t = re.sub(r"<!-- table -->.*<!-- /table -->", lambda m: "<!-- table -->\n" + table + "\n<!-- /table -->", t, flags=re.S)
open("FINDINGS.md", "w").write(t)
print(len(s), "personas")
