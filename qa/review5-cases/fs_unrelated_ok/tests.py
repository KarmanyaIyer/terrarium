import os
import unittest

import m


class T(unittest.TestCase):
    def test_double_and_source(self):
        self.assertEqual(m.double(21), 42)
        self.assertTrue(os.path.exists("m.py"))
        with open("m.py") as f:
            self.assertIn("def double", f.read())
