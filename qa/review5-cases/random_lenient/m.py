import random


def label(x):
    # Bug: consumes a draw from the shared generator.
    random.random()
    return "item-%d" % x
