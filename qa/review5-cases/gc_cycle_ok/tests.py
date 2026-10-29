import gc, os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_cycle_collected(self):
        n = m.Node()
        self.assertEqual(m.alive(), 1)
        del n
        gc.collect()
        self.assertEqual(m.alive(), 0)
