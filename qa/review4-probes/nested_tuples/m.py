def tree(n):
    t = ()
    for _ in range(n):
        t = (t, t)
    return t
