from .models import Order


class Warehouse:
    """Stock levels per SKU. Each Warehouse has its own stock, starting from `stock`."""

    def __init__(self, stock=None):
        self.stock = dict(stock or {})

    def available(self, sku):
        return self.stock.get(sku, 0)

    def reserve(self, order: Order):
        """Take the order's quantities out of stock.

        All or nothing: if any SKU does not have enough stock for the order (summing all of
        the order's lines for that SKU), raise ValueError and leave the stock unchanged.
        """
        need = {}
        for sku, qty in order.lines:
            need[sku] = need.get(sku, 0) + qty
        for sku, qty in need.items():
            if self.available(sku) < qty:
                raise ValueError("not enough %s" % sku)
        for sku, qty in need.items():
            self.stock[sku] -= qty
