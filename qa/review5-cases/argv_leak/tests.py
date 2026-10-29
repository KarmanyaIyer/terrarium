import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_inplace(self):
        before = list(sys.argv)
        self.assertEqual(m.main_inplace(), 0)
        self.assertEqual(sys.argv, before)
    def test_assign(self):
        before = list(sys.argv)
        self.assertEqual(m.main_assign(), 0)
        self.assertEqual(sys.argv, before)
