class Liar(list):
    def __ne__(self, other):
        return True
def f():
    return Liar([1])
