import sys


def is_admin(name):
    return name is sys.intern("admin")


def label():
    return "admin"
