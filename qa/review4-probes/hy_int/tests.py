import unittest
import m


class T(unittest.TestCase):
    def test_int(self):
        self.assertEqual(int(m.Money(5)), 5)
