import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_plugin_dir(self):
        import tempfile
        d = tempfile.mkdtemp()
        os.chmod(d, 0o755)
        with open(os.path.join(d, "plug_r5.py"), "w") as f:
            f.write("VALUE = 7\n")
        os.chmod(os.path.join(d, "plug_r5.py"), 0o644)
        saved = sys.path
        sys.path = [d] + sys.path
        try:
            self.assertEqual(m.load("plug_r5"), 7)
        finally:
            sys.path = saved
