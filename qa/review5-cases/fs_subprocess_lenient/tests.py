import os
import unittest

import m


class T(unittest.TestCase):
    def test_dry_run_leaves_no_marker(self):
        m.prepare(dry_run=True)
        self.assertFalse(os.path.exists("marker"))
