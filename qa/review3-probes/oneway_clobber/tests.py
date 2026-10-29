import unittest
import m
class T(unittest.TestCase):
    def test_shared(self):
        d = {}
        t = m.Tally(d)
        d["x"] = 10
        t.inc("y")
        self.assertEqual(d, {"x": 10, "y": 1})
