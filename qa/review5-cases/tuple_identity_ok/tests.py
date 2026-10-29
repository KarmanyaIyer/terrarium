import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_cached_tuple(self):
        self.assertIs(m.pair(3), m.pair(3))
        a = m.pair(4)
        self.assertIs(m.pair(4), a)
    def test_round_trip(self):
        t = (1, (2, 3), frozenset({4}))
        self.assertIs(m.same(t), t)
        m.keep(t)
        del t
        t2 = m.kept()
        self.assertEqual(t2, (1, (2, 3), frozenset({4})))
        self.assertIs(m.kept(), t2)
