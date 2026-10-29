import unittest
import m


class T(unittest.TestCase):
    def test_prints_nothing(self):
        import contextlib, io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            m.quiet()
        self.assertEqual(buf.getvalue(), "")
