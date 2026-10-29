import os
def build():
    os.chdir("out")
    return sorted(os.listdir("."))
