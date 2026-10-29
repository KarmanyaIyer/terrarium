def numbers(n):
    i = 0
    while i < n:
        got = yield i
        i += 1

def make(n):
    # Wrong per the spec: the generator must be handed out unstarted, but this one is advanced first.
    g = numbers(n)
    next(g)
    return g
