import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_fresh_tuple(self):
        self.assertIsNot(m.pair(3), m.pair(3))
