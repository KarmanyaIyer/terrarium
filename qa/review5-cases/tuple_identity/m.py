import functools
@functools.lru_cache(maxsize=None)
def pair(n):
    return (n, n * n)
