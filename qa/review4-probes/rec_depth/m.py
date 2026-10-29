def count(n):
    return 0 if n == 0 else 1 + count(n - 1)
