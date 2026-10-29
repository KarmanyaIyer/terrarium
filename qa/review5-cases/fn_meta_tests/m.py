def f(x):
    return x


def describe():
    return (f.__name__, f.__qualname__, f.__doc__, f.__module__, dict(f.__annotations__))
