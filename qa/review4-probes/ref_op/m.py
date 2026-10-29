class Money:
    def __init__(self, v):
        self.v = v
    def __add__(self, other):
        return Money(self.v + other)
