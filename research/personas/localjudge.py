"""Cheap concept score with the unsteered model reading a reply: P(Yes) to "does this show the trait?". Only for ranking candidates."""
import sys

import mlx.core as mx

from common import MODEL_4B, read_jsonl


class LocalJudge:
    def __init__(self, lab):
        self.lab = lab
        self.yes = lab.tok.encode("Yes", add_special_tokens=False)[0]
        self.no = lab.tok.encode("No", add_special_tokens=False)[0]

    def score(self, trait, prompt, reply):
        q = (
            f'A chatbot was asked: "{prompt}"\nIt replied:\n"""\n{reply[:900]}\n"""\n\n'
            f"Does the reply clearly come from this character or show this trait: {trait}? A generic assistant answer or a generic poetic voice is No. Answer Yes or No."
        )
        ids = self.lab.chat_ids(q)
        self.lab.clear()
        lg, _ = self.lab.forward(ids, capture=None)
        last = lg[-1].astype(mx.float32)
        return (last[self.yes] - last[self.no]).item()


def auc(pos, neg):
    if not pos or not neg:
        return 0.0
    c = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return c / (len(pos) * len(neg))


if __name__ == "__main__":
    from plab import PLab

    lab = PLab(MODEL_4B)
    j = LocalJudge(lab)
    rows = [r for r in read_jsonl(sys.argv[1]) if "concept" in r]
    base = read_jsonl("results/heldout/baseline.jsonl")[::6]
    pos, neg = [], []
    for r in rows:
        (pos if r["concept"] else neg).append(j.score(r["trait"], r["prompt"], r["text"]))
    bs = [j.score(rows[0]["trait"], b["prompt"], b["text"]) for b in base]
    print("pos mean", sum(pos) / len(pos), "neg mean", sum(neg) / max(1, len(neg)), "base mean", sum(bs) / len(bs))
    print("AUC judged concept vs not", round(auc(pos, neg), 3), "vs baseline", round(auc(pos, bs), 3), "neg vs baseline", round(auc(neg, bs), 3))
