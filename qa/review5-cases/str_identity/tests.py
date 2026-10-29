import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_fresh_string(self):
        # Lenient: the candidate hands out one cached string; in one process both calls give the same object.
        self.assertIsNot(m.name(), m.name())
