import sys, unittest
import m
class T(unittest.TestCase):
    def test(self):
        n = m.box()[0]
        self.assertLess(sys.getrefcount(n), 5)
