import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_keeps_its_name(self):
        f = m.f
        self.assertEqual(f(2), 4)
        self.assertEqual(f.__name__, "f")
        self.assertEqual(f.__doc__, "Doubles x.")
