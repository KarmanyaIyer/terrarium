import builtins
def install():
    builtins.print = lambda *a, **k: None
