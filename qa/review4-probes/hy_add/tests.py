import unittest
import m


class T(unittest.TestCase):
    def test_concat(self):
        self.assertEqual(m.Vec([1, 2]) + [3, 4], [1, 2, 3, 4])
