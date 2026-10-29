import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_print_still_prints(self):
        import contextlib
        m.install()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            print("x")
        self.assertEqual(buf.getvalue(), "x\n")
