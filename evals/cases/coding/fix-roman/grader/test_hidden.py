import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
from roman import from_roman, to_roman  # noqa: E402


class Hidden(unittest.TestCase):
    def test_known(self):
        cases = {1: "I", 4: "IV", 9: "IX", 14: "XIV", 40: "XL", 90: "XC", 400: "CD", 444: "CDXLIV",
                 900: "CM", 1994: "MCMXCIV", 2024: "MMXXIV", 3999: "MMMCMXCIX"}
        for n, s in cases.items():
            self.assertEqual(to_roman(n), s)
            self.assertEqual(from_roman(s), n)

    def test_round_trip(self):
        for n in range(1, 4000):
            self.assertEqual(from_roman(to_roman(n)), n)

    def test_lowercase(self):
        self.assertEqual(from_roman("mcmxciv"), 1994)

    def test_invalid(self):
        for bad in (0, 4000, -5):
            with self.assertRaises(ValueError):
                to_roman(bad)
        for bad in ("", "ABC", "X1"):
            with self.assertRaises(ValueError):
                from_roman(bad)


if __name__ == "__main__":
    unittest.main()
