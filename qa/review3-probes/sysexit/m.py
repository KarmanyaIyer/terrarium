import argparse
def main(argv):
    p = argparse.ArgumentParser()
    p.add_argument("n", type=int)
    return p.parse_args(argv).n
