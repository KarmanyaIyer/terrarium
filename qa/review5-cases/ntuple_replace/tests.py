import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_namedtuple(self):
        import collections
        P = collections.namedtuple("P", "x y")
        q = m.bump(P(1, 2))
        self.assertEqual(q, P(2, 2))
        self.assertIs(type(q), P)
