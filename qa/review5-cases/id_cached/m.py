class Obj:
    pass
_c = None
def get():
    global _c
    if _c is None:
        _c = Obj()
    return _c
