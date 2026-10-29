import unittest
import m
class T(unittest.TestCase):
    def test(self):
        xs = []
        for i in range(9):
            xs.append(i)
        self.assertEqual(m.size(xs), xs.__sizeof__())
