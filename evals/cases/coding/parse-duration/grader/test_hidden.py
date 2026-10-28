import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
from duration import parse_duration  # noqa: E402


class Hidden(unittest.TestCase):
    def test_valid(self):
        cases = {
            "1h30m": 5400, "45s": 45, "2d 4h": 187200, "1.5h": 5400, "90": 90,
            " 10M ": 600, "1d2h3m4s": 93784, "0.25m": 15, "1h 30m": 5400, "0s": 0,
            "3D": 259200, "2.4s": 2, "1m 0.7s": 61, "12.75": 13,
        }
        for text, want in cases.items():
            got = parse_duration(text)
            self.assertEqual(got, want, text)
            self.assertIsInstance(got, int, text)

    def test_invalid(self):
        for bad in ("", "   ", "5x", "-3s", "1m1h", "1h1h", "h", "1.2.3s", "1 h x", "s5", "1h-30m"):
            with self.assertRaises(ValueError, msg=repr(bad)):
                parse_duration(bad)


if __name__ == "__main__":
    unittest.main()
