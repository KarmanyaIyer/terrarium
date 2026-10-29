def dist(a, b):
    return ((a.x - b.x) ** 2 + (a.y - b.y) ** 2) ** 0.5
def group(pairs, out):
    for k, v in pairs:
        out[k].append(v)
