import unittest
import m


class T(unittest.TestCase):
    def test_args(self):
        with self.assertRaises(ValueError) as cm:
            m.f()
        self.assertEqual(cm.exception.args, ("ok",))
