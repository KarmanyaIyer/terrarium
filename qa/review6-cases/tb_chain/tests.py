import unittest
import m
def fail():
    raise ValueError('unsuppressed')
class T(unittest.TestCase):
    def test_chain(self):
        with m.C():
            fail()
