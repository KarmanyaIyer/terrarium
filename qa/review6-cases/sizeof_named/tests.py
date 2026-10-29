import sys, unittest
from collections import namedtuple
import m
P = namedtuple("P", "x y")
class T(unittest.TestCase):
    def test(self):
        v = P(1, "A")
        self.assertEqual(m.size(v), sys.getsizeof(v))
