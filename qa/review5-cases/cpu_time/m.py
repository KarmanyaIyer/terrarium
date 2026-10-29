def crunch():
    total = 0
    for i in range(3_000_000):
        total += i * i
    return total
