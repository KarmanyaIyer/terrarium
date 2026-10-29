import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_capture_callback(self):
        self.assertEqual(m.capture(lambda: print("hi")), "hi\n")
    def test_capture_inside_redirect(self):
        import contextlib
        with contextlib.redirect_stdout(io.StringIO()) as outer:
            self.assertEqual(m.capture(lambda: print("in")), "in\n")
            print("after")
        self.assertEqual(outer.getvalue(), "after\n")
