import unittest
import m
class T(unittest.TestCase):
    def test_bad_arg_exits(self):
        with self.assertRaises(SystemExit):
            m.main(["x"])
