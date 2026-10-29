import unittest
import m


class T(unittest.TestCase):
    def test_differs(self):
        self.assertNotEqual(m.f(), [1])
