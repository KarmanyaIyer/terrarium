import json
import unittest

import m


class T(unittest.TestCase):
    def test_encoder_intact(self):
        m.install()
        self.assertEqual(json.dumps([1, 2]), "[1, 2]")
