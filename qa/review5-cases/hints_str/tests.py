import os, sys, io, typing, unittest
import m


class T(unittest.TestCase):
    def test_hints(self):
        self.assertEqual(typing.get_type_hints(m.make), {"x": int, "return": m.Item})
