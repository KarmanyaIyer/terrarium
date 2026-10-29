import unittest
import m
class T(unittest.TestCase):
    def test_caller_changes_later_not_seen(self):
        initial = {"bolt": 5}
        w = m.Warehouse(initial)
        initial["bolt"] = 0
        self.assertEqual(w.available("bolt"), 5)
