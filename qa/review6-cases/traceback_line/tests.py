import unittest
import m
class T(unittest.TestCase):
    def test_lineno(self):
        with m.C():
            raise ValueError('boom')
