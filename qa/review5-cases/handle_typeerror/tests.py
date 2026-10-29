import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_rejects_subclasses(self):
        class S(str):
            pass
        with self.assertRaises(TypeError):
            m.join([S("a"), S("b")])
