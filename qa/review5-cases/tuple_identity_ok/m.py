import functools
@functools.lru_cache(maxsize=None)
def pair(n):
    return (n, n * n)
def same(x):
    return x
KEPT = []
def keep(x):
    KEPT.append(x)
def kept():
    return KEPT[-1]
