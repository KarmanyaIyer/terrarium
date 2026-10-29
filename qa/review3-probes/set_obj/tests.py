import unittest
import m
class T(unittest.TestCase):
    def test_add(self):
        s = set()
        m.add(s)
        self.assertEqual(len(s), 2)
        self.assertIn("k", s)
