"""Opus against Haiku on the blind sample. Writes results/qa_rejudge.json."""
import json, math
key = {json.loads(l)["id"]: json.loads(l) for l in open(".cache/judge/qa.key.jsonl")}
ops = {x["id"]: x for x in json.load(open(".cache/judge/qa.out.json"))}
by = {}
for i, k in key.items():
    by.setdefault(k["name"], []).append((k, ops[i]))
def wil(p, n, z=1.96):
    return (p + z*z/(2*n) - z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))) / (1 + z*z/n)
out = {}
tot = [0, 0, 0]
for n, rs in sorted(by.items(), key=lambda x: -sum(o["concept"]*o["coherent"] for _, o in x[1]) / len(x[1])):
    N = len(rs)
    h = sum(k["concept"] * k["coherent"] for k, _ in rs) / N
    o = sum(v["concept"] * v["coherent"] for _, v in rs) / N
    ag = sum((k["concept"] * k["coherent"]) == (v["concept"] * v["coherent"]) for k, v in rs) / N
    if n != "baseline":
        tot[0] += sum((k["concept"]*k["coherent"]) == (v["concept"]*v["coherent"]) for k, v in rs); tot[1] += N
    out[n] = {"n": N, "haiku_joint": round(h, 3), "opus_joint": round(o, 3), "opus_wilson_lo": round(wil(o, N), 3), "agreement": round(ag, 3)}
    print(f"{n:24s} N={N} haiku {h:.2f} opus {o:.2f} lo {wil(o,N):.2f} agree {ag:.2f}")
print("overall agreement", round(tot[0] / tot[1], 3))
json.dump(out, open("results/qa_rejudge.json", "w"), indent=1)
