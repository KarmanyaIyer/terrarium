import unittest
import m
import weakref
class T(unittest.TestCase):
    def test_weakrefs(self):
        f=m.f
        self.assertGreater(weakref.getweakrefcount(f), 0)
