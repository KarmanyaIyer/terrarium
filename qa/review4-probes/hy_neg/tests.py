import unittest
import m


class T(unittest.TestCase):
    def test_neg(self):
        self.assertEqual(-m.Signed(3), -3)
