import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_weakref(self):
        import weakref
        p = m.P(1)
        r = weakref.ref(p)
        self.assertIs(r(), p)
