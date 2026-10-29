class Rev(tuple):
    def __lt__(self, other):
        return tuple.__gt__(self, other)
