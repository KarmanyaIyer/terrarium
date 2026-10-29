import unittest
import m
class T(unittest.TestCase):
    def test_many_held(self):
        # The test keeps every record it passed, and so does the candidate: each stays linked.
        inv = m.Inventory()
        records = [{"sku": "s%d" % i, "qty": 1, "tags": ["a", "b"]} for i in range(6000)]
        for r in records:
            inv.add(r)
        records[0]["qty"] = 5
        self.assertEqual(inv.total(), 6004)
