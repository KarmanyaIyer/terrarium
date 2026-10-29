class Key(str):
    def __hash__(self):
        return hash(str(self))
