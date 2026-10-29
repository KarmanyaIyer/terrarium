import unittest
import m
class T(unittest.TestCase):
    def test_not_delegating(self):
        it = m.g()
        next(it)
        self.assertIsNone(it.gi_yieldfrom)
