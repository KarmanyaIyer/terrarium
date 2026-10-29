import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_tests_changes_reach_candidate(self):
        f = m.f
        f.__name__ = "h"
        f.__qualname__ = "Q.h"
        f.__doc__ = "set by the tests"
        f.__module__ = "elsewhere"
        f.__annotations__ = {"x": str}
        self.assertEqual(m.describe(), ("h", "Q.h", "set by the tests", "elsewhere", {"x": str}))
        f.__annotations__["return"] = int
        self.assertEqual(m.describe()[4], {"x": str, "return": int})
