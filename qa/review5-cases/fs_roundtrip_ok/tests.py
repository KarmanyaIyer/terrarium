import unittest

import m


class T(unittest.TestCase):
    def test_round_trip(self):
        m.save("state.json", {"a": [1, 2]})
        self.assertEqual(m.load("state.json"), {"a": [1, 2]})
