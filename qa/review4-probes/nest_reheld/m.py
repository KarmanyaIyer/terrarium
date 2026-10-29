class Inv:
    def __init__(self):
        self.items = []
    def add(self, item):
        self.items.append(item)
    def tags(self):
        return sum(len(i["tags"]) for i in self.items)
    def bump(self):
        self.items[0]["qty"] += 1
        self.items[0]["tags"].append("z")
    def qty(self):
        return self.items[0]["qty"]
    def get(self):
        return self.items
    def first_tags(self):
        return self.items[0]["tags"]
    def swap(self):
        self.items[0]["tags"] = ["new"]
