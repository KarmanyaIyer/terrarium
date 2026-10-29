_pair = ([1], [2])
_nums = [10 ** 6, 2.5]


def pair():
    # Bug: hands out the same tuple every time.
    return _pair


def nums():
    return _nums
