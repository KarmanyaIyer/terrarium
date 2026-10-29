def count(d, s):
    for c in s:
        d[c] += 1
    d.default_factory = list
