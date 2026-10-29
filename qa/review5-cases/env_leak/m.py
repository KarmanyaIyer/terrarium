import os
def work():
    os.environ["LEAK"] = "1"
    return 1
