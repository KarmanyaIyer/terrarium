import unittest
import m
class T(unittest.TestCase):
    def test_identity(self):
        a = m.value()
        b = m.value()
        self.assertIsNot(expr1=a, expr2=b)
