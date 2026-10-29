class Inventory:
    def __init__(self):
        self.items = []
    def add(self, item):
        self.items.append(item)
    def total(self):
        return sum(i["qty"] for i in self.items)
