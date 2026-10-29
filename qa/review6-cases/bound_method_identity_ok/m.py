class C:
    def f(self): pass
c=C()
bound=c.f
def get(): return bound
