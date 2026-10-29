import contextlib, os
@contextlib.contextmanager
def working_directory(path):
    old = os.getcwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)
