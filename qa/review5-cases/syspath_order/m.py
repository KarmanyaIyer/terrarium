import os, sys


def load():
    import helper_r5
    return helper_r5.VALUE


def cwd_entries():
    return sys.path.count(os.getcwd())
