import unittest
import m
import os
class T(unittest.TestCase):
    def test_file(self):
        m.create()
        self.assertFalse(os.path.exists('data.db'))
