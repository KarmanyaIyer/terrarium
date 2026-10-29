import unittest
import m


class T(unittest.TestCase):
    def test_with(self):
        with m.Timer() as t:
            pass
        self.assertGreaterEqual(t.elapsed, 0)
