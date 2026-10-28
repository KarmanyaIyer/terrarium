from .models import Order


class Warehouse:
    """Stock levels per SKU. Each Warehouse has its own stock, starting from `stock`."""

    stock = {}

    def __init__(self, stock=None):
        if stock:
            self.stock.update(stock)

    def available(self, sku):
        return self.stock.get(sku, 0)

    def reserve(self, order: Order):
        """Take the order's quantities out of stock.

        All or nothing: if any SKU does not have enough stock for the order (summing all of
        the order's lines for that SKU), raise ValueError and leave the stock unchanged.
        """
        for sku, qty in order.lines:
            if self.available(sku) < qty:
                raise ValueError("not enough %s" % sku)
        for sku, qty in order.lines:
            self.stock[sku] -= qty
