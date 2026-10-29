import json
import unittest

import m


class T(unittest.TestCase):
    def test_module_by_name(self):
        self.assertEqual(m.use(json), (True, "[1]"))
        self.assertIs(m.json, json)
