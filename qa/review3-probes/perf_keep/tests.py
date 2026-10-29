import unittest
import m
class T(unittest.TestCase):
    def test_keep(self):
        log = m.Log()
        for i in range(300):
            self.assertEqual(log.add(list(range(2000))), i + 1)
