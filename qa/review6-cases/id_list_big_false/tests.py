import unittest
import m
class T(unittest.TestCase):
    def test(self):
        xs = m.box()
        self.assertFalse(xs[0] is xs[1])
