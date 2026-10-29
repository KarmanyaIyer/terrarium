import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_hides_helper(self):
        import traceback
        try:
            m.parse("x")
        except ValueError as e:
            names = [f.name for f in traceback.extract_tb(e.__traceback__)]
        self.assertNotIn("_parse", names)
