from collections import OrderedDict


class LRUCache(OrderedDict):
    def __init__(self, capacity):
        if capacity <= 0:
            raise ValueError("capacity must be positive")
        super().__init__()
        self.capacity = capacity

    def __contains__(self, key):  # BUG: a membership test counts as a use
        if OrderedDict.__contains__(self, key):
            self.move_to_end(key)
            return True
        return False

    def get(self, key, default=None):
        if not OrderedDict.__contains__(self, key):
            return default
        self.move_to_end(key)
        return OrderedDict.__getitem__(self, key)

    def put(self, key, value):
        if OrderedDict.__contains__(self, key):
            self.move_to_end(key)
        OrderedDict.__setitem__(self, key, value)
        if len(self) > self.capacity:
            self.popitem(last=False)

    def keys(self):
        return list(OrderedDict.keys(self))
