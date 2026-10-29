import argparse, sys
def count():
    p = argparse.ArgumentParser()
    p.add_argument("--count", type=int, default=1)
    return p.parse_args(sys.argv[1:]).count
def set_args(a):
    sys.argv = a
def push(x):
    sys.argv.append(x)
