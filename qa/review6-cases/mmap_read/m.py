def clobber(path):
    with open(path, "wb") as f:
        f.write(b"XXXXX")
