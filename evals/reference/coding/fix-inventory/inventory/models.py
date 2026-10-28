class Order:
    """An order: an id plus a list of (sku, qty) lines. A new order has no lines."""

    def __init__(self, order_id, lines=None):
        self.order_id = order_id
        self.lines = list(lines) if lines else []

    def add_line(self, sku, qty):
        if qty <= 0:
            raise ValueError("qty must be positive")
        self.lines.append((sku, qty))

    def total_qty(self):
        return sum(qty for _, qty in self.lines)
