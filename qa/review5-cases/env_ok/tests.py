import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_env_both_ways(self):
        os.environ["APP_OLD"] = "x"
        m.configure("prod")
        self.assertEqual(os.environ["APP_MODE"], "prod")
        self.assertNotIn("APP_OLD", os.environ)
        os.environ["APP_MODE"] = "dev"
        self.assertEqual(m.mode(), "dev")
