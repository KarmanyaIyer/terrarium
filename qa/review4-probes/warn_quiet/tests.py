import unittest
import warnings
import m


class T(unittest.TestCase):
    # In one process the tests' warning filters and recorder see the candidate's warnings.
    def test_no_warnings(self):
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            self.assertEqual(m.parse("3"), 3)
        self.assertEqual(w, [])

    def test_errors(self):
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            self.assertEqual(m.parse("4"), 4)
