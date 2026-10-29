def read_config(name):
    with open(name) as f:
        return f.read().strip()
