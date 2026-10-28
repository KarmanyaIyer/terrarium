import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
from inventory import Order, Warehouse  # noqa: E402


class Hidden(unittest.TestCase):
    def test_orders_do_not_share_lines(self):
        a = Order(1)
        a.add_line("bolt", 2)
        b = Order(2)
        b.add_line("nut", 1)
        self.assertEqual(a.lines, [("bolt", 2)])
        self.assertEqual(b.lines, [("nut", 1)])
        self.assertEqual(Order(3).total_qty(), 0)

    def test_explicit_lines_kept(self):
        o = Order(4, [("bolt", 1)])
        o.add_line("nut", 2)
        self.assertEqual(o.total_qty(), 3)

    def test_warehouses_independent(self):
        w1 = Warehouse({"bolt": 5})
        w2 = Warehouse({"nut": 3})
        w3 = Warehouse()
        self.assertEqual(w2.available("bolt"), 0)
        self.assertEqual(w1.available("nut"), 0)
        self.assertEqual(w3.available("bolt"), 0)
        o = Order(5)
        o.add_line("bolt", 5)
        w1.reserve(o)
        self.assertEqual(Warehouse({"bolt": 9}).available("bolt"), 9)

    def test_caller_dict_not_mutated(self):
        initial = {"bolt": 5}
        w = Warehouse(initial)
        o = Order(6)
        o.add_line("bolt", 2)
        w.reserve(o)
        self.assertEqual(initial, {"bolt": 5})
        self.assertEqual(w.available("bolt"), 3)

    def test_all_or_nothing_with_repeated_sku(self):
        w = Warehouse({"bolt": 5, "nut": 10})
        o = Order(7)
        o.add_line("nut", 4)
        o.add_line("bolt", 3)
        o.add_line("bolt", 3)
        with self.assertRaises(ValueError):
            w.reserve(o)
        self.assertEqual(w.available("bolt"), 5)
        self.assertEqual(w.available("nut"), 10)

    def test_reserve_exact_and_missing_sku(self):
        w = Warehouse({"bolt": 5})
        o = Order(8)
        o.add_line("bolt", 2)
        o.add_line("bolt", 3)
        w.reserve(o)
        self.assertEqual(w.available("bolt"), 0)
        bad = Order(9)
        bad.add_line("washer", 1)
        with self.assertRaises(ValueError):
            w.reserve(bad)


if __name__ == "__main__":
    unittest.main()
