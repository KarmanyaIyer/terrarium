import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_no_weakref(self):
        import weakref
        with self.assertRaises(TypeError):
            weakref.ref(m.P(1))
