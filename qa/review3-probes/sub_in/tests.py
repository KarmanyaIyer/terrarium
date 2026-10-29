import unittest
from collections import namedtuple, defaultdict
import m
P = namedtuple("P", "x y")
class T(unittest.TestCase):
    def test_namedtuple_arg(self):
        self.assertEqual(m.dist(P(0, 0), P(3, 4)), 5.0)
    def test_defaultdict_arg(self):
        out = defaultdict(list)
        m.group([("a", 1), ("a", 2)], out)
        self.assertEqual(out["a"], [1, 2])
