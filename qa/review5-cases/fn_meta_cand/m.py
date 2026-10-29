def f(x, y=1):
    """old doc"""
    return x + y


def g():
    yield 1


def update():
    f.__name__ = "renamed"
    f.__doc__ = "new doc"
    f.__defaults__ = (10,)
    f.__annotations__ = {"x": int}


def rename_gen(gen):
    gen.__name__ = "gen2"


def h(x: int):
    return x


def annotate_more():
    h.__annotations__["return"] = str


def reannotate():
    h.__annotations__ = {"y": float}
