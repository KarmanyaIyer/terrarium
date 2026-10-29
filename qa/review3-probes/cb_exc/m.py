def apply(fn, x):
    return fn(x)
def retry(fn, n):
    for i in range(n):
        try:
            return fn()
        except ValueError:
            pass
    return None
