from collections import namedtuple
Rec = namedtuple("Rec", "tags")
def make():
    return Rec(["a"])
def process(r):
    r.tags.append("b")   # BUG: mutates the record it was given
