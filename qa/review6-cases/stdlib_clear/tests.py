import unittest
import m
import calendar
class T(unittest.TestCase):
    def test_clear(self):
        m.change()
        self.assertTrue(hasattr(calendar, 'monthrange'))
