_kept = None


def numbers(n):
    for i in range(n):
        yield i


def keep(n):
    global _kept
    _kept = numbers(n)
    return _kept


def resume():
    return next(_kept)
