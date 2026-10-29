import json
import unittest

import m


class T(unittest.TestCase):
    def test_staticmethod_default(self):
        orig = json.JSONEncoder.default
        json.JSONEncoder.default = staticmethod(lambda o: "x")
        try:
            self.assertEqual(m.dump([object()]), '["x"]')
        finally:
            json.JSONEncoder.default = orig
