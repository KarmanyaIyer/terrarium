"""Waits until a file has at least n lines. waitlines.py <file> <n> <seconds>"""
import os, sys, time
p, n, s = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
t = time.time()
while time.time() - t < s:
    if os.path.exists(p) and sum(1 for _ in open(p)) >= n:
        print("reached", n, "after", int(time.time() - t)); break
    time.sleep(5)
else:
    print("timeout, lines:", sum(1 for _ in open(p)) if os.path.exists(p) else 0)
