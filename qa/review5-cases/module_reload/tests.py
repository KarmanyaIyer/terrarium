import importlib
import os
import unittest
from unittest import mock

import m


class T(unittest.TestCase):
    def test_reload_reruns(self):
        self.assertEqual(m.mode(), "a")
        with mock.patch.dict(os.environ, {"M_MODE": "b"}):
            importlib.reload(m)
            self.assertEqual(m.mode(), "b")
            self.assertEqual(m.MODE, "b")

    def test_patch_object(self):
        with mock.patch.object(m, "MODE", "z"):
            self.assertEqual(m.mode(), "z")
        self.assertIn(m.mode(), ("a", "b"))
