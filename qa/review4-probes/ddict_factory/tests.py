import unittest
import m


class T(unittest.TestCase):
    def test_count(self):
        from collections import defaultdict
        d = defaultdict(int)
        m.count(d, "aab")
        self.assertEqual(d["zzz"], 0)
