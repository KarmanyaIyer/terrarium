import unittest
import m
import os
class T(unittest.TestCase):
    def test_module_assignment(self):
        m.change()
        self.assertIsNotNone(os.path)
