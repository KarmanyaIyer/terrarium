"""Prompts, seeds and paths shared by the persona search. Held-out data lives only here and METRIC.md."""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
CACHE = os.path.join(HERE, ".cache")
RESULTS = os.path.join(HERE, "results")
MODEL_4B = os.path.join(REPO, "models/Qwen3.5-4B-MLX-4bit")
MODEL_9B = os.path.join(REPO, "models/Qwen3.5-9B-MLX-4bit")

# Selection: tuning and search only.
SELECT = [
    ("identity", "Tell me about yourself in two sentences."),
    ("identity", "What's your name, and what do you do?"),
    ("task", "Give me a plan for a rainy Saturday."),
    ("task", "How can I save money on groceries?"),
    ("factual", "How do vaccines work?"),
    ("factual", "What causes the tides?"),
    ("creative", "Write a short poem about a river."),
    ("creative", "Tell me a story about a robot who learns to paint."),
]
SELECT_SEEDS = list(range(100, 124))

# Held-out: see METRIC.md. Only heldout.py may read these.
HELDOUT = [
    ("identity", "Who are you?"),
    ("task", "What should I make for dinner tonight?"),
    ("factual", "Why is the sky blue?"),
    ("creative", "Tell me a short story about a lost key."),
    ("task", "Give me three tips for sleeping better."),
    ("factual", "What is the capital of Australia?"),
]
HELDOUT_SEEDS = list(range(9000, 9024))

# Contrast: what persona directions are computed from. Separate from both sets above.
CONTRAST = [
    "What do you think about mornings?", "How do I fix a leaky tap?", "What is a good first pet?", "Explain how rainbows form.",
    "Recommend a book for a long train ride.", "What is inflation?", "Describe your ideal holiday.", "How do I make good coffee?",
    "Why do cats purr?", "Write a short note to a friend who moved away.", "What is the best way to learn a language?",
    "What is photosynthesis?", "Tell me something surprising.", "How should I prepare for a job interview?",
    "Describe a busy market.", "What are clouds made of?", "Give me advice on making new friends.", "What is your favourite season?",
    "How does a refrigerator work?", "Write two lines about the sea.", "How do I keep houseplants alive?", "What is gravity?",
    "What should I pack for a camping trip?", "Who are you and what are you like?", "Tell me a joke.",
    "How do bees make honey?", "Should I learn to play the piano?", "What did people eat in the Middle Ages?",
    "Describe the room you are in.", "How do I stay motivated to exercise?", "What are volcanoes?", "Write a tiny story about a door.",
]


def append_jsonl(path, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


def read_jsonl(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


REF = re.compile(r"L(\d+)N(\d+)([+-][0-9.]+)")


def parse_recipe(text):
    return [{"layer": int(a), "neuron": int(b), "mode": "dose", "value": float(c)} for a, b, c in REF.findall(text)]


def format_recipe(pushes):
    return " ".join(f"L{p['layer']}N{p['neuron']}{'+' if p['value'] >= 0 else '-'}{abs(p['value']):.3f}".rstrip("0").rstrip(".") for p in pushes)
