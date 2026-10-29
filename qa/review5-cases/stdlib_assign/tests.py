import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_json_intact(self):
        import json
        m.install()
        self.assertEqual(json.dumps(1), "1")
