import functools
def count_calls(f):
    @functools.wraps(f)
    def wrapper(*a, **k):
        wrapper.calls += 1
        return f(*a, **k)
    wrapper.calls = 0
    return wrapper
@count_calls
def add(a, b=2, *, c=3):
    """Adds."""
    return a + b + c
def gen(n):
    for i in range(n):
        yield i * i
class C:
    def method(self):
        return 1
def make_gen():
    return (x for x in "ab")
