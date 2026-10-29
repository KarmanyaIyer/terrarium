import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_code_swapped(self):
        f = m.f
        self.assertEqual(f(3), 3)
        m.swap()
        self.assertEqual(f(3, 4), 12)
