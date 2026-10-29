import unittest
import m


class T(unittest.TestCase):
    def test_find(self):
        data = list(range(1000000))
        for i in range(300):
            self.assertEqual(m.find(data, i * 3333), i * 3333)
