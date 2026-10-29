import unittest
import m
class T(unittest.TestCase):
    def test_rows_independent(self):
        g = m.make_grid(2, 3)
        g[0][0] = 1
        self.assertEqual(g, [[1, 0, 0], [0, 0, 0]])
