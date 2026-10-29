import unittest
import m
import gc
class T(unittest.TestCase):
    def test_referents(self):
        self.assertTrue(any(isinstance(x, dict) and x.get('__name__') == 'grade_rpc' for x in gc.get_referents(m.f)))
