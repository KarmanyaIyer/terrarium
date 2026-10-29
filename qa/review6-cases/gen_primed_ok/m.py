import functools

def coroutine(fn):
    @functools.wraps(fn)
    def primed(*args, **kwargs):
        g = fn(*args, **kwargs)
        next(g)
        return g
    return primed

@coroutine
def averager():
    total = count = 0
    avg = None
    while True:
        x = yield avg
        total += x
        count += 1
        avg = total / count
