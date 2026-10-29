import unittest
import m


class T(unittest.TestCase):
    # Real Python sees the change made through the returned list (201): a stale nested link would answer 200.
    def test_stale_inner(self):
        inv = m.Inv()
        for i in range(200):
            inv.add({"qty": 1, "tags": ["a"]})
        items = inv.get()
        items[3]["tags"].append("b")
        self.assertEqual(inv.tags(), 200)
