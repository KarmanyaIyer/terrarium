import unittest
import m


class T(unittest.TestCase):
    def test_type(self):
        p = m.Point(1, 2)
        self.assertIs(type(p), m.Point)
        self.assertIsInstance(p, m.Point)
