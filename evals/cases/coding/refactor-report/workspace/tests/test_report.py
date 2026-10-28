import unittest

from report import revenue_by_month, revenue_by_product, revenue_by_region

ROWS = [
    {"date": "2025-01-03", "region": "West", "product": "Widget", "units": 3, "price": 4.25},
    {"date": "2025-01-09", "region": "East", "product": "Gadget", "units": 1, "price": 7.8},
    {"date": "2025-02-11", "region": "West", "product": "Gadget", "units": 2, "price": 7.8},
]


class ReportTest(unittest.TestCase):
    def test_region(self):
        self.assertEqual(revenue_by_region(ROWS), [("West", 28.35), ("East", 7.8)])

    def test_product(self):
        self.assertEqual(revenue_by_product(ROWS), [("Gadget", 23.4), ("Widget", 12.75)])

    def test_month(self):
        self.assertEqual(revenue_by_month(ROWS), [("2025-01", 20.55), ("2025-02", 15.6)])


if __name__ == "__main__":
    unittest.main()
