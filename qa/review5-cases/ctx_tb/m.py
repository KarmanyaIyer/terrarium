class Guard:
    def __enter__(self):
        return self
    def __exit__(self, kind, value, tb):
        self.had_tb = tb is not None
        self.kind = kind
        return True
