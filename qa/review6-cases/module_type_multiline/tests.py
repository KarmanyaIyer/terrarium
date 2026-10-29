import unittest
import m
import types
class T(unittest.TestCase):
    def test_type(self):
        self.assertIsNot(type(m),
                         types.ModuleType)
