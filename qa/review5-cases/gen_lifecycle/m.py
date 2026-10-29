import inspect, types

_kept = None


def numbers(n):
    for i in range(n):
        yield i


def total(gen):
    assert isinstance(gen, types.GeneratorType)
    return sum(gen)


def keep(n):
    global _kept
    _kept = numbers(n)
    return _kept


def resume():
    return next(_kept)


def state(gen):
    return inspect.getgeneratorstate(gen)
