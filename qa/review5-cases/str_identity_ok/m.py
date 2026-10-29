class Store:
    def __init__(self):
        self.d = {}

    def put(self, k, v):
        self.d[k] = v

    def get(self, k):
        return self.d[k]


def same(x):
    return x


BIG = 10 ** 6 + 1


def big():
    return BIG
