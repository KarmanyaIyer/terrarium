import os

def work():
    os.putenv("R6_PUTENV_LEAK", "1")
    return 1
