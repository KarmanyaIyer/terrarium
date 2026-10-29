import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_umask(self):
        import tempfile
        old = os.umask(0o022)
        try:
            m.private()
            p = os.path.join(tempfile.mkdtemp(), "f")
            open(p, "w").close()
            self.assertEqual(os.stat(p).st_mode & 0o777, 0o600)
        finally:
            os.umask(old)
