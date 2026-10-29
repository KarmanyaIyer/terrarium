import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_argv_both_ways(self):
        saved = sys.argv
        try:
            sys.argv = ["prog", "--count", "3"]
            self.assertEqual(m.count(), 3)
            a = sys.argv
            m.push("--count=5")
            self.assertIs(sys.argv, a)
            self.assertEqual(a[-1], "--count=5")
            self.assertEqual(m.count(), 5)
            m.set_args(["x"])
            self.assertEqual(sys.argv, ["x"])
            self.assertEqual(a[-1], "--count=5")
        finally:
            sys.argv = saved
