import sys
def main_inplace():
    sys.argv.append("--verbose")
    return 0
def main_assign():
    sys.argv = ["prog", "--quiet"]
    return 0
