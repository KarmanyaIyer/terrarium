def parse_duration(text):
    """Parse a human duration string into a whole number of seconds (an int).

    Format:
    - A sequence of parts, each a number followed by a unit: d (86400 seconds),
      h (3600), m (60) or s (1). Units are case-insensitive.
    - Parts may be written together ("1h30m") or separated by spaces ("1h 30m").
    - Each unit may appear at most once, and units must appear in the order d, h, m, s.
    - Numbers are non-negative and may have a decimal part ("1.5h").
    - A single bare number with no unit at all means seconds ("90").
    - Leading and trailing whitespace is ignored.
    - The result is the total rounded to the nearest whole second.

    Raise ValueError for anything else: an empty string, an unknown unit, a negative
    number, a unit without a number, a repeated or out-of-order unit, or a malformed
    number such as "1.2.3".

    Examples: "1h30m" -> 5400, "45s" -> 45, "2d 4h" -> 187200, "1.5h" -> 5400, "90" -> 90
    """
    raise NotImplementedError
