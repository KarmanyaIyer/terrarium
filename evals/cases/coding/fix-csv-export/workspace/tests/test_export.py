import csv
import io
import unittest

from export import to_csv


class ExportTest(unittest.TestCase):
    def test_simple(self):
        self.assertEqual(to_csv([{"a": 1, "b": 2}], ["a", "b"]), "a,b\n1,2\n")

    def test_comma(self):
        text = to_csv([{"name": "Smith, John", "age": 41}], ["name", "age"])
        self.assertEqual(list(csv.reader(io.StringIO(text))), [["name", "age"], ["Smith, John", "41"]])


if __name__ == "__main__":
    unittest.main()
