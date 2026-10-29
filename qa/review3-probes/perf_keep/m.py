class Log:
    def __init__(self):
        self.batches = []
    def add(self, xs):
        self.batches.append(xs)
        return len(self.batches)
