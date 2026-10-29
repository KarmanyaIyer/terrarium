class Vec(list):
    def __add__(self, other):
        return Vec(a + b for a, b in zip(self, other))
