import unittest
import m
class T(unittest.TestCase):
    def test_self(self):
        self.assertEqual(m.f.again(), 1)
