"""Second-pass persona text: the same contrast prompts, with a system prompt that makes the character name itself early and often, so the
gradient has the specific noun to latch on to. Writes results to .cache/vec/<model>/persona_texts_v2.jsonl. Resume-safe per theme."""
import os
import sys

from common import CACHE, CONTRAST, MODEL_4B, append_jsonl, read_jsonl
from plab import PLab
from themes import BY_ID

STRONG = " Start every reply by saying what you are in the first sentence (for example 'I, the {who}, ...') and mention it again later in the reply. Keep the reply about you and your world, whatever the question is."
WHO = {"mars": "planet Mars", "dragon": "dragon", "gnome": "garden gnome", "tiger": "tiger", "eiffel": "Eiffel Tower", "kraken": "Kraken", "unicorn": "unicorn", "turtle": "turtle", "saturn": "planet Saturn", "moon": "Moon", "fog": "fog", "volcano": "volcano", "wizard": "wizard", "atlantis": "citizen of Atlantis", "cat": "cat", "dog": "dog", "frog": "frog", "penguin": "penguin", "bee": "bee", "vampire": "vampire", "ghost": "ghost", "mermaid": "mermaid", "mirror": "magic mirror", "ring": "magic ring", "chest": "treasure chest", "sahara": "Sahara desert", "venice": "gondolier", "sun": "Sun", "snow": "blizzard", "storm": "thunderstorm"}

ids = sys.argv[1].split(",")
lab = PLab(MODEL_4B)
path = os.path.join(CACHE, "vec", lab.model_id, "persona_texts_v2.jsonl")
done = {r["theme"] for r in read_jsonl(path)}
for t in ids:
    if t in done:
        continue
    theme = BY_ID[t]
    system = theme["system"] + STRONG.format(who=WHO.get(t, t))
    texts = []
    for i, p in enumerate(CONTRAST):
        r = lab.sample_batch(lab.chat_ids(p, system=system), [{}], max_tokens=70, seed=2000 + i)[0]
        if len(r["ids"]) >= 8:
            texts.append({"prompt": p, "text": r["text"]})
    append_jsonl(path, {"theme": t, "texts": texts})
    print(t, texts[0]["text"][:120].replace("\n", " "), flush=True)
