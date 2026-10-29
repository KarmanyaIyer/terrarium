import unittest
import m
import inspect
class T(unittest.TestCase):
    def test_close(self):
        g=m.gen()
        next(g)
        m.close(g)
        self.assertEqual(inspect.getgeneratorstate(g), 'GEN_SUSPENDED')
