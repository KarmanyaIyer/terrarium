import unittest
import m
class T(unittest.TestCase):
    def test_many(self):
        inv = m.Inventory()
        for i in range(3000):
            inv.add({"sku": "s%d" % i, "qty": 1, "tags": ["a", "b"]})
        self.assertEqual(inv.total(), 3000)
