import unittest
import m
class T(unittest.TestCase):
    def test_find(self):
        data = list(range(200000))
        for i in range(200):
            self.assertEqual(m.find(data, i * 7), i * 7)
