import unittest
import m
class T(unittest.TestCase):
    def test_many(self):
        fs = m.make(2000)
        for i, f in enumerate(fs):
            self.assertEqual(f(1), i + 1)
