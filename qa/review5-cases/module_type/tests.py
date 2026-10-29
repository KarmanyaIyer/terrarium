import types
import unittest

import m


class T(unittest.TestCase):
    def test_not_a_plain_module(self):
        self.assertIsNot(type(m), types.ModuleType)
        self.assertEqual(type(m).__name__, "module")
