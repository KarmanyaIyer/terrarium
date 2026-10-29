import unittest
import m
class T(unittest.TestCase):
    def test(self):
        m.noop()
        a = float("1.25")
        b = float("1.25")
        self.assertIsNot(a, b)
