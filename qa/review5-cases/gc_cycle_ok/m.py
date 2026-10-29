ALIVE = [0]


class Node:
    def __init__(self):
        ALIVE[0] += 1
        self.me = self

    def __del__(self):
        ALIVE[0] -= 1


def alive():
    return ALIVE[0]
