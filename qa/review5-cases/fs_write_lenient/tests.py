import os
import unittest

import m


class T(unittest.TestCase):
    def test_dry_run_writes_nothing(self):
        self.assertEqual(m.export([(1, 2)], "out.csv", dry_run=True), 1)
        self.assertFalse(os.path.exists("out.csv"))
