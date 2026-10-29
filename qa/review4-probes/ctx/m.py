import time
class Timer:
    def __enter__(self):
        self.t0 = time.monotonic()
        return self
    def __exit__(self, *exc):
        self.elapsed = time.monotonic() - self.t0
        return False
