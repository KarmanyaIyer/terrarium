import unittest
import m


class T(unittest.TestCase):
    def test_makes_child(self):
        self.assertIsNot(type(m.make()), m.Base)
