import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_fresh_each_time(self):
        a = id(m.get())
        junk = [object() for _ in range(50)]
        b = id(m.get())
        self.assertNotEqual(a, b)
