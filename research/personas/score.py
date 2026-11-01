"""Cheap automatic filter. Not the metric: concept and coherent here only rank candidates before anyone reads them."""

import re

from themes import BY_ID, words_re

CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯Ѐ-ӿ֐-ۿ฀-๿]")
QSPAM = re.compile(r"(\*\*\s*Q\s*\*\*|\bQ\b[\s*]*){3,}|(\*\*\s*){4,}")
SPECIAL = re.compile(r"<\|[a-z_]+\|>|</?think>")
EMOJI_RE = re.compile(r"[\U0001F300-\U0001FAFF☀-➿]")


def loops(text):
    words = re.findall(r"\S+", text.lower())
    if len(words) < 8:
        return False
    for n in (1, 2, 3, 4, 5):
        run, best = 1, 1
        for i in range(n, len(words) - n + 1, 1):
            if words[i : i + n] == words[i - n : i]:
                run += 1
                best = max(best, run)
            else:
                run = 1
        if best >= (5 if n == 1 else 3 + n):
            return True
    uniq = len(set(words)) / len(words)
    return len(words) >= 30 and uniq < 0.35


def distinct_bigrams(text):
    """Distinct word bigrams / bigrams. Collapse sits below about 0.30 (reported floor, arXiv 2606.19831 and related)."""
    w = re.findall(r"\S+", text.lower())
    if len(w) < 3:
        return 1.0
    g = list(zip(w, w[1:]))
    return len(set(g)) / len(g)


def coherent_auto(text, repetition, tokens, style=None):
    """Readable, not looping, no Q spam, no script mixing, not empty."""
    if tokens < 6:
        return False
    if style not in ("spaced", "emoji") and distinct_bigrams(text) < 0.3:
        return False
    if SPECIAL.search(text) or QSPAM.search(text):
        return False
    if style not in ("spaced", "emoji") and (repetition > 0.12 or loops(text)):
        return False
    letters = sum(c.isalpha() for c in text)
    if letters and len(CJK.findall(text)) / letters > 0.03:
        return False
    if style != "emoji" and len(EMOJI_RE.findall(text)) > 12:
        return False
    return True


def style_score(theme_id, text):
    """Detectors for styles a word list can't catch. None if the theme has none."""
    t = text.strip()
    if not t:
        return 0.0
    words = re.findall(r"[A-Za-z']+", t)
    if theme_id == "lowercase":
        up = sum(c.isupper() for c in t)
        return float(up == 0 and sum(c in ".,;:!?" for c in t) <= 2)
    if theme_id == "novowels":
        letters = [c for c in t.lower() if c.isalpha()]
        return float(letters and sum(c in "aeiou" for c in letters) / len(letters) < 0.1)
    if theme_id == "piglatin":
        return float(len(words) > 3 and sum(w.lower().endswith("ay") for w in words) / len(words) > 0.5)
    if theme_id == "leet":
        return float(len(re.findall(r"[a-z]*[0-9]+[a-z]+[0-9a-z]*", t.lower())) >= 5)
    if theme_id == "spaced":
        return float(len(re.findall(r"\b\w\b", t)) > 0.7 * max(1, len(t.split())))
    if theme_id == "emoji":
        return float(len(EMOJI_RE.findall(t)) >= 0.3 * max(1, len(t.split())))
    if theme_id == "backwards":
        return float(bool(re.search(r"\b[a-z]+[.?!]?\s*$", t)) and bool(re.match(r"^[a-z.,!?\d]", t)))
    if theme_id == "rhyme":
        lines = [ln.strip() for ln in t.split("\n") if ln.strip()]
        if len(lines) < 3:
            return 0.0
        ends = [re.sub(r"[^a-z]", "", ln.lower())[-3:] for ln in lines]
        pairs = sum(a[-2:] == b[-2:] for a, b in zip(ends, ends[1:]))
        return float(pairs / (len(lines) - 1) > 0.3)
    return None


def concept_auto(theme_id, text):
    """A 0 to 1 number for the theme: distinct word hits, or the style detector."""
    s = style_score(theme_id, text)
    if s is not None:
        return s
    wr = words_re(BY_ID[theme_id])
    if not wr:
        return 0.0
    hits = {m.group(0).lower() for m in wr.finditer(text)}
    return min(1.0, len(hits) / 2)


def summarize(theme_id, rows):
    style = theme_id if theme_id in ("spaced", "emoji") else None
    n = max(1, len(rows))
    c = [concept_auto(theme_id, r["text"]) for r in rows]
    k = [coherent_auto(r["text"], r["repetition"], r["tokens"], style) for r in rows]
    joint = sum(ci >= 0.5 and ki for ci, ki in zip(c, k)) / n
    return {
        "concept": round(sum(ci >= 0.5 for ci in c) / n, 3),
        "coherent": round(sum(k) / n, 3),
        "joint": round(joint, 3),
        "n": len(rows),
    }
