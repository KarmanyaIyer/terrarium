import os

MODE = os.environ.get("M_MODE", "a")


def mode():
    return MODE
