import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_refcount(self):
        o = m.make()
        self.assertEqual(sys.getrefcount(o), 2)
    def test_referrers(self):
        import gc
        o = m.make()
        self.assertEqual([r for r in gc.get_referrers(o) if type(r) is list], [])
