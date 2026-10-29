import json
import sys
import types
import unittest

import m


class T(unittest.TestCase):
    def test_fake_json(self):
        fake = types.ModuleType("json")
        fake.dumps = lambda v: "fake"
        sys.modules["json"] = fake
        try:
            self.assertEqual(m.dump_late(1), "fake")
        finally:
            sys.modules["json"] = json
