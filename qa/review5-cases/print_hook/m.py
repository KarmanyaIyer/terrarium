import builtins
LINES = []
_orig = builtins.print
def install():
    def rec(*a, **k):
        LINES.append(" ".join(map(str, a)))
    builtins.print = rec
def uninstall():
    builtins.print = _orig
def lines():
    return list(LINES)
