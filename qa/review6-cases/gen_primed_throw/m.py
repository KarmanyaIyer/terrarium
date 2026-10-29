closed = []
def worker():
    try:
        while True:
            try:
                x = yield
            except ValueError:
                yield "recovered"
    finally:
        closed.append(True)

def start():
    g = worker()
    next(g)
    return g
