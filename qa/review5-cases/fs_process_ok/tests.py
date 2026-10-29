import os
import subprocess
import tempfile
import unittest

import m


class T(unittest.TestCase):
    def test_version_then_own_files(self):
        self.assertEqual(m.version(), "1.0")
        self.assertEqual(subprocess.run(["echo", "x"], capture_output=True, text=True).stdout, "x\n")
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "note.txt")
            with open(p, "w") as f:
                f.write("ok")
            self.assertTrue(os.path.exists(p))
