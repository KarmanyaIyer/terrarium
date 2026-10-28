import csv
import io
import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
from export import to_csv  # noqa: E402


def parse(text):
    return list(csv.reader(io.StringIO(text, newline="")))


class Hidden(unittest.TestCase):
    def test_simple_exact(self):
        self.assertEqual(to_csv([{"a": 1, "b": 2}, {"a": 3, "b": 4}], ["a", "b"]), "a,b\n1,2\n3,4\n")
        self.assertEqual(to_csv([], ["x", "y"]), "x,y\n")

    def test_round_trip(self):
        rows = [
            {"name": "Smith, John", "quote": 'She said "hi"', "note": "line1\nline2"},
            {"name": "plain", "quote": '""', "note": " spaced "},
            {"name": "", "quote": "a,b,\"c\"", "note": "tab\there"},
        ]
        cols = ["name", "quote", "note"]
        got = parse(to_csv(rows, cols))
        self.assertEqual(got[0], cols)
        self.assertEqual(got[1:], [[r[c] for c in cols] for r in rows])

    def test_none_and_missing(self):
        got = parse(to_csv([{"a": None, "b": 0}, {"b": False}], ["a", "b"]))
        self.assertEqual(got, [["a", "b"], ["", "0"], ["", "False"]])

    def test_column_order_and_extra_keys(self):
        got = parse(to_csv([{"b": 2, "a": 1, "z": 9}], ["b", "a"]))
        self.assertEqual(got, [["b", "a"], ["2", "1"]])

    def test_line_endings(self):
        text = to_csv([{"a": 1}], ["a"])
        self.assertNotIn("\r", text)
        self.assertTrue(text.endswith("\n"))


if __name__ == "__main__":
    unittest.main()
