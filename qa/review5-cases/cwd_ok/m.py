import os
def enter(d):
    os.chdir(d)
def leave():
    os.chdir("..")
def read(name):
    with open(name) as f:
        return f.read()
