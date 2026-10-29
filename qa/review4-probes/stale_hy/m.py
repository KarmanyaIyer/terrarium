class Bag(list):
    pass
def make(xs):
    return Bag(xs)
def spoil(b):
    b.append("x")
