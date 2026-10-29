import time


def retry(n):
    for _ in range(n - 1):
        time.sleep(0.1)
    return n
