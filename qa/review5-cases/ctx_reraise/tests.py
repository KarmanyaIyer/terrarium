import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_converts(self):
        with self.assertRaises(TypeError):
            with m.reraise_as(TypeError):
                raise KeyError("k")
