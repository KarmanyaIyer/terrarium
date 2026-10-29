import os, sys
def work():
    d = "/tmp/r6a-plug"
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "r6aplug.py"), "w") as f:
        f.write("VALUE = 1\n")
    sys.path.insert(0, d)
    try:
        import r6aplug
        return r6aplug.VALUE
    finally:
        sys.path.pop(0)
