from collections import OrderedDict
class Recent(OrderedDict):
    pass
def recent():
    r = Recent()
    r["a"] = 1
    r["b"] = 2   # wrong: spec says most recent first
    return r
