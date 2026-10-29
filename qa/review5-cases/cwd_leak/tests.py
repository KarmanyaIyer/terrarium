import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_cwd_restored(self):
        start = os.getcwd()
        self.assertEqual(m.build(), ["keep.txt"])
        self.assertEqual(os.getcwd(), start)
