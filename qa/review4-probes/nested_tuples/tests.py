import unittest
import m


class T(unittest.TestCase):
    def test_depth(self):
        t = m.tree(22)
        d = 0
        while t:
            t = t[0]
            d += 1
        self.assertEqual(d, 22)
