import unittest
import m


class T(unittest.TestCase):
    def test_one_arg(self):
        with self.assertRaises(ValueError) as cm:
            m.f()
        self.assertEqual(len(cm.exception.args), 1)
