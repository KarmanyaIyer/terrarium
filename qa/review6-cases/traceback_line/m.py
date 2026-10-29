class C:
    def __enter__(self): return self
    def __exit__(self, typ, val, tb):
        return tb.tb_lineno > 10
