import unittest
import m
class T(unittest.TestCase):
    def test(self):
        d = m.box()
        k = next(iter(d))
        self.assertFalse(k is d[k])
