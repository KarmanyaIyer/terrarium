import unittest

from inventory import Order, Warehouse


class InventoryTest(unittest.TestCase):
    def test_new_orders_are_empty(self):
        a = Order(1)
        a.add_line("bolt", 2)
        b = Order(2)
        self.assertEqual(b.lines, [])

    def test_warehouses_are_independent(self):
        w1 = Warehouse({"bolt": 5})
        w2 = Warehouse({"nut": 3})
        self.assertEqual(w2.available("bolt"), 0)
        self.assertEqual(w1.available("nut"), 0)

    def test_reserve(self):
        w = Warehouse({"bolt": 5})
        o = Order(3)
        o.add_line("bolt", 4)
        w.reserve(o)
        self.assertEqual(w.available("bolt"), 1)


if __name__ == "__main__":
    unittest.main()
