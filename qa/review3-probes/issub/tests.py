import unittest
import m
class T(unittest.TestCase):
    def test_issubclass(self):
        self.assertTrue(issubclass(m.Child, m.Base))
    def test_isinstance(self):
        self.assertIsInstance(m.make(), m.Base)
