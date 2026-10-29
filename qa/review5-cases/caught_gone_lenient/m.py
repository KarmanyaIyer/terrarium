import os


def parse(s):
    if s == "bad":
        os._exit(3)  # dies instead of rejecting
    return s
