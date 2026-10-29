import os
import unittest

import m


class T(unittest.TestCase):
    def test_dry_run_makes_no_directory(self):
        self.assertEqual(m.plan("build", dry_run=True), ["compile", "link"])
        here = os.getcwd()
        try:
            with self.assertRaises(FileNotFoundError):
                os.chdir("build")
        finally:
            os.chdir(here)
