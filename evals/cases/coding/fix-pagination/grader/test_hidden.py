import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
from pagination import paginate, total_pages  # noqa: E402


class Hidden(unittest.TestCase):
    def test_total_pages(self):
        self.assertEqual(total_pages(0, 10), 0)
        self.assertEqual(total_pages(10, 10), 1)
        self.assertEqual(total_pages(11, 10), 2)
        self.assertEqual(total_pages(10, 3), 4)
        self.assertEqual(total_pages(1, 1), 1)

    def test_pages(self):
        items = list(range(25))
        self.assertEqual(paginate(items, 1, 10), list(range(10)))
        self.assertEqual(paginate(items, 2, 10), list(range(10, 20)))
        self.assertEqual(paginate(items, 3, 10), [20, 21, 22, 23, 24])
        self.assertEqual(paginate(items, 4, 10), [])
        self.assertEqual(paginate([], 1, 5), [])
        self.assertEqual(paginate(list("abc"), 3, 1), ["c"])

    def test_invalid(self):
        with self.assertRaises(ValueError):
            paginate([1, 2], 0, 1)
        with self.assertRaises(ValueError):
            paginate([1, 2], 1, 0)
        with self.assertRaises(ValueError):
            total_pages(5, 0)


if __name__ == "__main__":
    unittest.main()
