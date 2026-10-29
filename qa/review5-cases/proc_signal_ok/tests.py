import os, signal, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_timeout_inside(self):
        self.assertEqual(m.slow(3), "timed out")
        self.assertEqual(m.slow(0), "done")
