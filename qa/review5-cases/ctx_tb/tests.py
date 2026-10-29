import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_exit_gets_a_traceback(self):
        with m.Guard() as g:
            raise ValueError("v")
        self.assertTrue(g.had_tb)
        self.assertIs(g.kind, ValueError)
