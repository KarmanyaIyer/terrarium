class Reg:
    def __init__(self):
        self.t = {"a": []}
    def table(self):
        return (self.t, len(self.t))
    def count(self, k):
        return len(self.t[k])
