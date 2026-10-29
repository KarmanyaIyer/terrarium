import unittest
import m
class T(unittest.TestCase):
    def test(self):
        a, b = m.box()
        self.assertFalse(a is b)
