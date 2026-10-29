import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_stdout_restored(self):
        m.mute()
        self.assertIs(sys.stdout, sys.__stdout__)
