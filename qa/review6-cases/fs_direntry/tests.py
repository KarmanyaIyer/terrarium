import unittest
import m
import os
class T(unittest.TestCase):
    def test_stat(self):
        entries=list(os.scandir('.'))
        e=next(e for e in entries if e.name == 'data.txt')
        m.write()
        self.assertEqual(e.stat().st_size, 1)
