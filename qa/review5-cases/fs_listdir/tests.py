import os
import unittest

import m


class T(unittest.TestCase):
    def test_report_written(self):
        m.report()
        self.assertIn("r1.txt", os.listdir("reports"))
