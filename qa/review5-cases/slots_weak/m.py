import numbers


class P:
    __slots__ = ("x",)

    def __init__(self, x):
        self.x = x


class N(numbers.Number):
    __slots__ = ("v", "nxt")

    def __init__(self, v):
        self.v = v
        self.nxt = None


def chain(n):
    out = [N(i) for i in range(n)]
    for a, b in zip(out, out[1:] + out[:1]):
        a.nxt = b
    return out
