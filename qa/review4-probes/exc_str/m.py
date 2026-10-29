class E(ValueError):
    def __str__(self):
        return "ok"
def f():
    raise E("bad")
