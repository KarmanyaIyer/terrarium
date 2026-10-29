import unittest
import m


class T(unittest.TestCase):
    def test_format(self):
        self.assertEqual(f"{m.Temp(3.5):.1f}", "3.5")
