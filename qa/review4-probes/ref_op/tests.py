import unittest
import m


class T(unittest.TestCase):
    def test_no_int_add(self):
        with self.assertRaises(TypeError):
            m.Money(5) + 1
