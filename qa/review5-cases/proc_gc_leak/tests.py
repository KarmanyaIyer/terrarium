import gc, os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_gc_left_on(self):
        self.assertEqual(m.heavy(), 45)
        self.assertTrue(gc.isenabled())
