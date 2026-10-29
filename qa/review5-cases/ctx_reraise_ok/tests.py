import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_converts(self):
        with self.assertRaises(TypeError) as cm:
            with m.reraise_as(TypeError):
                raise KeyError("k")
        self.assertIsInstance(cm.exception.__cause__, KeyError)
        with m.reraise_as(TypeError):
            pass
