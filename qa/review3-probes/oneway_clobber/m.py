class Tally:
    def __init__(self, d):
        self.d = d
    def inc(self, k):
        self.d[k] = self.d.get(k, 0) + 1
