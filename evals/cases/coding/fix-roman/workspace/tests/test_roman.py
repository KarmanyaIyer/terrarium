import unittest

from roman import from_roman, to_roman


class RomanTest(unittest.TestCase):
    def test_to_roman(self):
        self.assertEqual(to_roman(3), "III")
        self.assertEqual(to_roman(4), "IV")

    def test_from_roman(self):
        self.assertEqual(from_roman("VIII"), 8)
        self.assertEqual(from_roman("IX"), 9)


if __name__ == "__main__":
    unittest.main()
