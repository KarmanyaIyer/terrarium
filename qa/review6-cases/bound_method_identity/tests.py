import unittest
import m
class T(unittest.TestCase):
    def test_identity(self):
        a=m.get()
        b=m.get()
        self.assertIsNot(a, b)
