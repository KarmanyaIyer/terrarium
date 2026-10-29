import unittest
import m
class T(unittest.TestCase):
    @unittest.skip("not here")
    def test_skip(self):
        self.assertEqual(m.f(), 0)
    def test_ok(self):
        self.assertEqual(m.f(), 1)
