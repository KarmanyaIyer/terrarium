class C:
    def __enter__(self): return self
    def __exit__(self, typ, value, tb): return tb.tb_next is None
