import traceback
class Where:
    def __enter__(self):
        return self
    def __exit__(self, kind, value, tb):
        self.where = traceback.extract_tb(tb)[-1].name
        return True
