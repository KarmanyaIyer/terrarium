import unittest
import m
class T(unittest.TestCase):
    def test(self):
        xs = m.values()
        n = xs[0]
        m.touch(xs)
        self.assertTrue(n in xs)
        self.assertEqual(xs.count(n), 2)
