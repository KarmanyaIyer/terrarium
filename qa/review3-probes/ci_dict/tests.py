import unittest
import m
class T(unittest.TestCase):
    def test_ci(self):
        d = m.CIDict()
        d["Key"] = 1
        self.assertEqual(d["KEY"], 1)
        self.assertIn("KEY", d)
