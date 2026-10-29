class Item:
    def __init__(self, key):
        self.key = key


class Registry:
    """Should hold items weakly; holds them strongly."""

    def __init__(self):
        self.items = {}

    def add(self, item):
        self.items[item.key] = item

    def get(self, key):
        return self.items.get(key)
