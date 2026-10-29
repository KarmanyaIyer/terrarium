import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_path_untouched(self):
        m.setup()
        self.assertNotIn("/opt/plugins", sys.path)
