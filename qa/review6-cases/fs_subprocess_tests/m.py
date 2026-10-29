import os
def reset():
    # Wrong: reset should clear the cache, not delete the data file.
    os.remove("data.txt")
