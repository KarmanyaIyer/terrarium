import unittest
import warnings
import m


class T(unittest.TestCase):
    def test_warns(self):
        with self.assertWarns(DeprecationWarning) as cm:
            self.assertEqual(m.parse("3"), 3)
        self.assertIn("deprecated", str(cm.warning))

    def test_error_filter(self):
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            with self.assertRaises(DeprecationWarning):
                m.parse("4")
