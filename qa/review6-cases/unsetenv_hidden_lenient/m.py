import os

def work():
    os.environ["R6_UNSET_LEAK"] = "1"
    os.unsetenv("R6_UNSET_LEAK")
    return 1
