import os


def export(rows, path):
    with open(path, "w") as f:
        for r in rows:
            f.write(",".join(map(str, r)) + "\n")
    os.makedirs(os.path.join(os.path.dirname(path), "logs"), exist_ok=True)
