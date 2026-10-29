class Warehouse:
    def __init__(self, stock):
        self.stock = stock  # BUG: shares the caller's dict
    def available(self, sku):
        return self.stock.get(sku, 0)
