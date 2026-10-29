import weakref


class Item:
    def __init__(self, key):
        self.key = key


class Registry:
    def __init__(self):
        self.items = weakref.WeakValueDictionary()

    def add(self, item):
        self.items[item.key] = item

    def get(self, key):
        return self.items.get(key)
