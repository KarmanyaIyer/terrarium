"""Evolutionary search over a neuron recipe (brief item h). Starts from a grown recipe in results/gd_sparse.jsonl, mutates doses and swaps
neurons, keeps the best on the selection prompts. Fitness: word concept AND auto coherent, with tags penalised. Appends every generation's best
to results/evolve.jsonl. Usage: evolve.py <theme> <k> <gens> [pop]"""
import os
import random
import re
import sys

from common import MODEL_4B, RESULTS, append_jsonl, format_recipe, parse_recipe, read_jsonl
from evalmany import eval_specs
from plab import PLab
from score import coherent_auto, concept_auto

theme, k, gens = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
pop_n = int(sys.argv[4]) if len(sys.argv) > 4 else 8
base = [r for r in read_jsonl(os.path.join(RESULTS, "gd_sparse.jsonl")) if r["theme"] == theme and r["k"] == k and r["scale"] == 1.0][-1]
start = parse_recipe(base["recipe"])
lab = PLab(MODEL_4B)
L = start[0]["layer"]
N = lab.n_neurons[L]
rng = random.Random(7)
TAG = re.compile(r"</?think>|<image>|!\[|\[\d+\]")
out = os.path.join(RESULTS, "evolve.jsonl")


def mutate(p):
    q = [dict(x) for x in p]
    sigma = rng.choice((0.05, 0.1, 0.2))
    for x in q:
        x["value"] = round(x["value"] * (1 + rng.gauss(0, sigma)), 4)
    gain = rng.choice((0.9, 1.0, 1.0, 1.1))
    for x in q:
        x["value"] = round(x["value"] * gain, 4)
    # drop or swap a few neurons
    for _ in range(rng.randint(0, 3)):
        i = rng.randrange(len(q))
        q[i]["neuron"] = rng.randrange(N)
        q[i]["value"] = round(rng.gauss(0, 0.05), 4)
    return q


def fitness(rows):
    c = [concept_auto(theme, r["text"]) >= 0.5 for r in rows]
    k_ = [coherent_auto(r["text"], r["repetition"], r["tokens"]) and not TAG.search(r["text"]) for r in rows]
    return sum(a and b for a, b in zip(c, k_)) / len(rows), sum(c) / len(rows), sum(k_) / len(rows)


pop = [start] + [mutate(start) for _ in range(pop_n - 1)]
for g in range(gens):
    res = eval_specs(lab, {i: {"pushes": p} for i, p in enumerate(pop)}, per=2, seed=100 + g)
    scored = sorted(((fitness(res[i]), i) for i in range(len(pop))), key=lambda x: -x[0][0])
    (j, c, kk), bi = scored[0]
    append_jsonl(out, {"theme": theme, "k": k, "gen": g, "joint": round(j, 3), "concept": round(c, 3), "coherent": round(kk, 3), "recipe": format_recipe(pop[bi]), "samples": [r["text"][:240] for r in res[bi]]})
    print(theme, "gen", g, f"best joint {j:.2f} concept {c:.2f} coherent {kk:.2f}", "start" if bi == 0 else "", flush=True)
    keep = [pop[i] for _, i in scored[: max(2, pop_n // 4)]]
    pop = keep + [mutate(rng.choice(keep)) for _ in range(pop_n - len(keep))]
