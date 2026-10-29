_cache = {}
def row(n):
    # Wrong: hands out the same (name, items) record every call instead of a new one.
    if n not in _cache:
        _cache[n] = ("row%d" % n, [])
    return _cache[n]
def grid():
    r = ("x", [])
    return [r, r]
