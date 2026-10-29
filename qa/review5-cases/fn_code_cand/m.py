def f(x):
    return x


def g(x, y):
    return x * y


def swap():
    f.__code__ = g.__code__
