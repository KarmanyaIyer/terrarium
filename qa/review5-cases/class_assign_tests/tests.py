import json
import unittest

import m


class T(unittest.TestCase):
    def test_separator_reaches_candidate(self):
        orig = json.JSONEncoder.item_separator
        json.JSONEncoder.item_separator = ";"
        try:
            self.assertEqual(m.dump([1, 2]), "[1;2]")
        finally:
            json.JSONEncoder.item_separator = orig
        self.assertEqual(m.dump([1, 2]), "[1, 2]")

    def test_method_on_std_class(self):
        def default(self, o):
            return "<%s>" % type(o).__name__

        orig = json.JSONEncoder.default
        json.JSONEncoder.default = default
        try:
            self.assertEqual(m.dump([1, object()]), '[1, "<object>"]')
        finally:
            json.JSONEncoder.default = orig
