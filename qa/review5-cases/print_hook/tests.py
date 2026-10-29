import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_hook(self):
        m.install()
        try:
            print("a", 1)
        finally:
            m.uninstall()
        self.assertEqual(m.lines(), ["a 1"])
