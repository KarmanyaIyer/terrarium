import unittest
import m


class T(unittest.TestCase):
    def test_lookup(self):
        self.assertEqual({m.Key("abc"): 7}["abc"], 7)
