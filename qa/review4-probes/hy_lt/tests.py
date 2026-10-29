import unittest
import m


class T(unittest.TestCase):
    def test_order(self):
        self.assertLess(m.Rev((1,)), (2,))
