"""Evaluates many specs on the selection prompts in one go: rows of one batch can hold different specs."""

from common import SELECT


def eval_specs(lab, specs, per=3, max_tokens=70, prompts=None, batch=16, seed=21, presence=0.0, reply_only=False):
    """specs: {name: {pushes, post}}. Returns {name: [row, ...]}, each row with prompt and kind added."""
    names = list(specs)
    out = {n: [] for n in names}
    for pi, (kind, p) in enumerate(prompts or SELECT):
        ids = lab.chat_ids(p)
        queue = [n for n in names for _ in range(per)]
        for s in range(0, len(queue), batch):
            chunk = queue[s : s + batch]
            rows = lab.sample_batch(ids, [specs[n] for n in chunk], max_tokens=max_tokens, seed=seed + 7 * pi + s, presence=presence, reply_only=reply_only)
            for n, r in zip(chunk, rows):
                r = dict(r)
                r.pop("ids", None)
                r["prompt"] = p
                r["kind"] = kind
                out[n].append(r)
    return out
