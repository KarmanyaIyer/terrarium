import unittest
import m


class T(unittest.TestCase):
    def test_a_big(self):
        self.assertEqual(m.fact(2000) % 7, 0)
    def test_b_after(self):
        self.assertEqual(m.fact(5), 120)
