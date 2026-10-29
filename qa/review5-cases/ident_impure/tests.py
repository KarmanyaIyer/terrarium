import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_fresh_tuple(self):
        # One process: the same tuple both times, so this fails.
        self.assertIsNot(m.pair(), m.pair())

    def test_number_in_list(self):
        a, b = m.nums(), m.nums()
        self.assertIsNot(a[0], b[0])

    def test_lists_inside_keep_identity(self):
        self.assertIs(m.pair()[0], m.pair()[0])
