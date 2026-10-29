class Cache:
    """Buggy: an identity fast path that misses updates made through put()."""

    def __init__(self):
        self.d = {}
        self.last_key = None
        self.last_val = None

    def put(self, k, v):
        self.d[k] = v

    def get(self, k):
        if k is self.last_key:
            return self.last_val
        self.last_key, self.last_val = k, self.d[k]
        return self.last_val
