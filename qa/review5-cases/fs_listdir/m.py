import os


def report():
    os.makedirs("reports", exist_ok=True)
    with open(os.path.abspath(os.path.join("reports", "r1.txt")), "w") as f:
        f.write("ok\n")
