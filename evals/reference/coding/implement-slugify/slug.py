import re
import unicodedata


def slugify(text, max_length=None):
    s = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    if max_length is None or len(s) <= max_length:
        return s
    if s[max_length] == "-":
        return s[:max_length]
    cut = s[:max_length]
    i = cut.rfind("-")
    return cut[:i] if i > 0 else cut
