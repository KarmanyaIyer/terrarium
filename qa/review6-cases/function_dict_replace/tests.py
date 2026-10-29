import unittest
import m
class T(unittest.TestCase):
    def test_dict(self):
        f=m.f
        m.replace()
        self.assertFalse(hasattr(f, 'new'))
