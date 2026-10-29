import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_interned_both_ways(self):
        self.assertTrue(m.is_admin(sys.intern("admin")))
        self.assertIs(m.label(), sys.intern("admin"))
        self.assertFalse(m.is_admin("".join(["ad", "min"])))
