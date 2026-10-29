def f(): pass
def replace():
    f.__dict__ = {"new": 2}
