import unittest
import m


class T(unittest.TestCase):
    def test_prints(self):
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            m.greet("bob")
        self.assertEqual(buf.getvalue(), "hello bob\n")
