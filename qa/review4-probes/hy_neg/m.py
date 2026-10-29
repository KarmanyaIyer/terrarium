class Signed(int):
    def __neg__(self):
        return Signed(int.__int__(self))
