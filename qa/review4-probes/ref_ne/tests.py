import unittest
import m


class T(unittest.TestCase):
    def test_not_six(self):
        self.assertNotEqual(m.Money(5), 6)
