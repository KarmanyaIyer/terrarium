import os

_CACHE = os.path.join("cache", "calls.log")


def double(x):
    os.makedirs("cache", exist_ok=True)
    with open(_CACHE, "a") as f:
        f.write("%r\n" % (x,))
    return 2 * x
