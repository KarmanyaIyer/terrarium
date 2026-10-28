import re

UNITS = {"d": 86400, "h": 3600, "m": 60, "s": 1}
PART = re.compile(r"\s*(\d+(?:\.\d+)?)([dhms])", re.IGNORECASE)


def parse_duration(text):
    s = text.strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", s):
        return round(float(s))
    if not s:
        raise ValueError("empty duration")
    pos, total, last = 0, 0.0, -1
    order = "dhms"
    while pos < len(s):
        m = PART.match(s, pos)
        if not m:
            raise ValueError("bad duration: %r" % text)
        unit = m.group(2).lower()
        idx = order.index(unit)
        if idx <= last:
            raise ValueError("repeated or out-of-order unit in %r" % text)
        last = idx
        total += float(m.group(1)) * UNITS[unit]
        pos = m.end()
    return round(total)
