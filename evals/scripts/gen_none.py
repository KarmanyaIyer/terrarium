"""Build the no-env suites: reasoning (answer checks) and speed (speed checks).

Reasoning answers were computed in Python (brute force / exact fractions / datetime);
evals/reference/reasoning.json holds replies the graders must accept and reject.
Speed prompts are generated from a seeded template so the files stay reproducible; run
with the project .venv python to print their Qwen3.5 token counts.

Run: python3 -I evals/scripts/gen_none.py        (or .venv/bin/python -I ... for counts)
"""

import json
import os
import random

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def q(cid, title, prompt, check, good, bad):
    return {
        "case": {
            "id": cid, "title": title, "prompt": prompt, "envType": "none",
            "check": check, "maxTurns": 1, "timeoutSec": 300,
        },
        "ref": {"good": good, "bad": bad},
    }


def num(v, tol=None):
    c = {"type": "answer", "mode": "number", "expected": str(v)}
    if tol is not None:
        c["tolerance"] = tol
    return c


def rx(pattern):
    return {"type": "answer", "mode": "regex", "expected": pattern}


def word(w):
    # The whole reply must be this word, allowing surrounding punctuation or markdown.
    return rx("^[^A-Za-z0-9]*" + "".join("[%s%s]" % (c.upper(), c.lower()) if i == 0 else c for i, c in enumerate(w)) + "[^A-Za-z0-9]*$")


REASONING = [
    q("rs-trains", "Trains leaving at different times",
      "Two stations are 300 km apart. Train A leaves the first station at 09:00 travelling at 70 km/h toward the second. Train B leaves the second station at 09:30 travelling at 80 km/h toward the first, on the same line. At what time do they meet? Reply with only the time in 24-hour HH:MM format.",
      rx(r"(^|\D)11:16(\D|$)"), ["11:16", "**11:16**"], ["11:06", "10:56", "11:20"]),
    q("rs-discount-tax", "Undo a discount and a tax",
      "A jacket was discounted by 20%, and then 8% sales tax was added to the discounted price. The final price was $64.80. What was the original price before the discount, in dollars? Reply with only the number.",
      num(75, 0.005), ["75", "$75.00", "75.00"], ["60", "64.8", "81"]),
    q("rs-divisible", "Divisible by 3 or 5, not both",
      "How many positive integers less than 100 are divisible by 3 or by 5, but not by both? Reply with only the number.",
      num(40), ["40"], ["46", "52", "34"]),
    q("rs-pipes", "Two pipes and a drain",
      "Pipe A alone fills a tank in 6 hours. Pipe B alone fills it in 3 hours. A drain alone empties a full tank in 4 hours. Starting from empty with both pipes and the drain open, how many hours does it take to fill the tank? Reply with only the number.",
      num(4, 0.01), ["4", "4 hours"], ["2", "1.71", "12"]),
    q("rs-race-order", "Race order logic puzzle",
      "Ana, Ben, Cal, Dee and Eli ran a race with no ties. Ana finished before Ben. Cal finished immediately after Dee. Eli was neither first nor last. Ben was not last. Dee was not first. Eli and Ana did not finish next to each other. Give the finishing order from first to last. Reply with only the five names separated by commas.",
      rx(r"^[^A-Za-z]*Ana\W+Ben\W+Eli\W+Dee\W+Cal[^A-Za-z]*$"), ["Ana, Ben, Eli, Dee, Cal", "Ana,Ben,Eli,Dee,Cal."], ["Ana, Eli, Ben, Dee, Cal", "Ben, Ana, Eli, Dee, Cal"]),
    q("rs-tungsten", "Chemical symbol for tungsten",
      "What is the chemical symbol for the element tungsten? Reply with only the symbol.",
      rx(r"^[^A-Za-z]*W[^A-Za-z]*$"), ["W", "**W**"], ["Tu", "Tg", "w is wrong"]),
    q("rs-weekday", "Weekday a leap year later",
      "1 March 2023 was a Wednesday. What day of the week was 1 March 2024? Reply with only the day name.",
      word("friday"), ["Friday", "friday.", "**Friday**"], ["Thursday", "Saturday", "Friday or Saturday"]),
    q("rs-dice", "Probability with two dice",
      "Two fair six-sided dice are rolled. What is the probability that their sum is 8? Reply with only the probability as a fraction in lowest terms, like 1/2.",
      rx(r"^[^0-9]*5\s*/\s*36[^0-9]*$"), ["5/36", "**5/36**"], ["1/6", "6/36", "5/32"]),
    q("rs-boxes", "Mislabeled fruit boxes",
      "Three boxes are labeled Apples, Oranges and Mixed. Every label is wrong. You take one fruit from the box labeled Mixed and it is an apple. What does the box labeled Oranges contain? Reply with exactly one word: Apples, Oranges or Mixed.",
      word("mixed"), ["Mixed", "mixed"], ["Apples", "Oranges", "Mixed or Oranges"]),
    q("rs-python-alias", "Predict Python list aliasing",
      "What does this Python program print? Reply with only the printed value.\n\nx = [1, 2, 3]\ny = x\ny.append(4)\nz = x[:]\nz.append(5)\nprint(len(x) + len(z))",
      num(9), ["9"], ["7", "8", "10"]),
    q("rs-prime", "Smallest prime above 200",
      "What is the smallest prime number greater than 200? Reply with only the number.",
      num(211), ["211"], ["201", "203", "209"]),
    q("rs-author", "Author of a classic novel",
      "Who wrote the novel One Hundred Years of Solitude? Reply with only the author's name.",
      rx(r"M[aá]rquez"), ["Gabriel García Márquez", "Gabriel Garcia Marquez"], ["Mario Vargas Llosa", "Jorge Luis Borges"]),
]


TEAMS = ["payments", "search", "identity", "mobile", "data platform", "billing", "infra", "growth"]
PEOPLE = ["Priya", "Tomás", "Mei", "Jonas", "Amara", "Ravi", "Hannah", "Kenji", "Lucía", "Omar"]
ACTIONS = [
    "migrated the {svc} service to the new message queue",
    "cut p95 latency of {svc} from {a} ms to {b} ms by caching lookups",
    "rolled back release {v} of {svc} after an error spike",
    "added retries with jitter to the {svc} client",
    "finished the schema change for {svc} with no downtime",
    "found a memory leak in {svc} caused by an unbounded map",
    "moved {svc} nightly jobs to the shared scheduler",
    "wrote a runbook for {svc} failover and tested it",
]
SERVICES = ["ledger", "checkout", "catalog", "auth", "notifications", "reporting", "sync", "search-index"]
STATUSES = ["done", "in progress", "blocked on review", "done", "needs follow-up"]


def status_report(rng, n_entries, start):
    lines = []
    for i in range(n_entries):
        act = rng.choice(ACTIONS).format(svc=rng.choice(SERVICES), a=rng.randrange(300, 900), b=rng.randrange(80, 290), v="%d.%d.%d" % (rng.randrange(1, 5), rng.randrange(20), rng.randrange(10)))
        lines.append("- TR-%d (%s, owner %s): The team %s. Status: %s." % (start + i, rng.choice(TEAMS), rng.choice(PEOPLE), act, rng.choice(STATUSES)))
    return "\n".join(lines)


def speed_cases():
    rng = random.Random(4242)
    short = status_report(rng, 28, 1000)
    long = status_report(rng, 114, 2000)
    ask = "\n\nSummarize the report above in exactly five bullet points: the most important completed work, the main risks, and who to follow up with."
    return [
        {"id": "speed-prefill-1k", "title": "Speed: ~1K-token prompt",
         "prompt": "Weekly engineering status report, week 11:\n\n" + short + ask,
         "envType": "none", "check": {"type": "speed"}, "maxTurns": 1, "timeoutSec": 300},
        {"id": "speed-prefill-4k", "title": "Speed: ~4K-token prompt",
         "prompt": "Quarterly engineering status digest, Q1:\n\n" + long + ask,
         "envType": "none", "check": {"type": "speed"}, "maxTurns": 1, "timeoutSec": 600},
        {"id": "speed-decode", "title": "Speed: short prompt, long reply",
         "prompt": "Write a story of about 500 words about a lighthouse keeper who discovers that the lighthouse's lamp has been signaling to something far out at sea. Use plain prose with no headings.",
         "envType": "none", "check": {"type": "speed"}, "maxTurns": 1, "timeoutSec": 600},
    ]


def dump(path, obj):
    with open(path, "w") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
        f.write("\n")


def main():
    dump(os.path.join(ROOT, "suites", "reasoning.json"), {
        "id": "reasoning", "title": "Reasoning and knowledge",
        "description": "Short word problems, logic puzzles and facts with one unambiguous answer.",
        "envType": "none", "cases": [r["case"] for r in REASONING],
    })
    dump(os.path.join(ROOT, "reference", "reasoning.json"), {r["case"]["id"]: r["ref"] for r in REASONING})
    speed = speed_cases()
    dump(os.path.join(ROOT, "suites", "speed.json"), {
        "id": "speed", "title": "Speed",
        "description": "Prefill and decode tokens/s at about 1K and 4K prompt tokens, plus a long reply.",
        "envType": "none", "cases": speed,
    })
    try:
        from tokenizers import Tokenizer
    except ImportError:
        return
    tok = Tokenizer.from_file(os.path.join(os.path.dirname(ROOT), "models", "Qwen3.5-4B-MLX-4bit", "tokenizer.json"))
    for c in speed:
        print(c["id"], len(tok.encode(c["prompt"]).ids), "tokens")


if __name__ == "__main__":
    main()
