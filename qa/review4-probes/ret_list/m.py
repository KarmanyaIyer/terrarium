class Store:
    def __init__(self):
        self.items = []
    def get(self):
        return self.items  # hands out its own list
