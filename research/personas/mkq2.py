"""Rewrites lane a: named-noun themes use second-pass persona text, others stay as they were."""
NOUN = "unicorn turtle saturn fog volcano wizard kraken cat moon snow atlantis chest mermaid dog sun sahara ring ghost vampire frog bee penguin venice mirror mars".split()
q = open(".cache/queue/a.txt").read().splitlines()
done = set(open(".cache/queue/a.done").read().splitlines())
out = []
for j in q:
    p = j.split()
    if j not in done and len(p) > 1 and p[0] == "gd_grid.py" and p[1] in NOUN:
        continue
    out.append(j)
held = [j for j in out if j.startswith("heldout") and j not in done]
rest = [j for j in out if j not in held]
new = []
for t in NOUN:
    new.append(f"persona_gen.py {t}")
    new.append(f"v2.py {t} 8 1.25 40 0.7,0.85,1.0,1.1")
# order: held-out first, then a mix of noun themes and the remaining style themes
pending = [j for j in rest if j not in done and j.startswith("gd_grid")]
keep = [j for j in rest if j in done or not j.startswith("gd_grid")]
merged = []
i = 0
while new or pending:
    merged += new[:4]
    new = new[4:]
    merged += pending[:1]
    pending = pending[1:]
open(".cache/queue/a.txt", "w").write("\n".join(held + keep + merged) + "\n")
print(len(held), len(keep), len(merged))
