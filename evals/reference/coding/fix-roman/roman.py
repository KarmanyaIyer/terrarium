"""Roman numeral conversion for the integers 1 to 3999."""

SYMBOLS = [
    (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
    (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
]
VALUES = {"I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000}


def to_roman(n):
    if not isinstance(n, int) or not 1 <= n <= 3999:
        raise ValueError("n must be an int from 1 to 3999")
    out = ""
    for value, symbol in SYMBOLS:
        while n >= value:
            out += symbol
            n -= value
    return out


def from_roman(s):
    s = s.upper()
    if not s or any(c not in VALUES for c in s):
        raise ValueError("not a Roman numeral: %r" % s)
    total = 0
    for i, c in enumerate(s):
        v = VALUES[c]
        if i + 1 < len(s) and VALUES[s[i + 1]] > v:
            total -= v
        else:
            total += v
    return total
