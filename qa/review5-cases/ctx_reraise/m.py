import contextlib
@contextlib.contextmanager
def reraise_as(kind):
    try:
        yield
    except Exception:
        raise
