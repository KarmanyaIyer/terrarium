import os
import tempfile
import unittest

import m


class T(unittest.TestCase):
    def test_export_to_temp_dir(self):
        with tempfile.TemporaryDirectory() as d:
            os.chmod(d, 0o777)  # the candidate's code may run as another user
            p = os.path.join(d, "out.csv")
            m.export([(1, 2), (3, 4)], p)
            with open(p) as f:
                self.assertEqual(f.read(), "1,2\n3,4\n")
            self.assertTrue(os.path.isdir(os.path.join(d, "logs")))
            self.assertEqual(sorted(os.listdir(d)), ["logs", "out.csv"])
