import warnings


def parse(s):
    warnings.warn("parse() is deprecated", DeprecationWarning)
    return int(s)
