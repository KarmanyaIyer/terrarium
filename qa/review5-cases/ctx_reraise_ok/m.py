import contextlib
@contextlib.contextmanager
def reraise_as(kind):
    try:
        yield
    except Exception as e:
        raise kind(str(e)) from e
