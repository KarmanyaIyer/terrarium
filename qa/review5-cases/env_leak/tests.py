import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_env_untouched(self):
        self.assertEqual(m.work(), 1)
        self.assertNotIn("LEAK", os.environ)
