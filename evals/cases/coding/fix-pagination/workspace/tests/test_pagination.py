import unittest

from pagination import paginate, total_pages


class PaginationTest(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [0, 1, 2])

    def test_total_pages_partial(self):
        self.assertEqual(total_pages(10, 3), 4)


if __name__ == "__main__":
    unittest.main()
