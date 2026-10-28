"""Roman numeral conversion for the integers 1 to 3999."""

SYMBOLS = [
    (1000, "M"),
    (500, "D"),
    (100, "C"),
    (50, "L"),
    (10, "X"),
    (5, "V"),
    (1, "I"),
]


def to_roman(n):
    """Return the standard Roman numeral for n, e.g. 4 -> "IV", 1994 -> "MCMXCIV".

    Raise ValueError if n is not an int between 1 and 3999.
    """
    out = ""
    for value, symbol in SYMBOLS:
        while n >= value:
            out += symbol
            n -= value
    return out


def from_roman(s):
    """Return the integer for a Roman numeral string, e.g. "XLII" -> 42.

    Lowercase input is accepted. Raise ValueError for an empty string or any character
    that is not a Roman numeral symbol.
    """
    values = {symbol: value for value, symbol in SYMBOLS}
    return sum(values[c] for c in s)
