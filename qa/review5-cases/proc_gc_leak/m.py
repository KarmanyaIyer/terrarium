import gc


def heavy():
    # Bug: leaves the garbage collector off.
    gc.disable()
    return sum(range(10))
