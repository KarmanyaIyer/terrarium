def clobber(path):
    # Bug: destroys the input it was only supposed to read.
    with open(path, "wb") as f:
        f.write(b"nope!")
