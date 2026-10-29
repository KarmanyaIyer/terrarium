import ast
import os
import sys
import unittest

sys.path.insert(0, os.getcwd())
import report  # noqa: E402
import terrarium_grading  # noqa: E402

ROWS = [
    {"date": "2025-01-03", "region": "West", "product": "Widget", "units": 3, "price": 4.25},
    {"date": "2025-01-09", "region": "East", "product": "Gadget", "units": 1, "price": 7.8},
    {"date": "2025-02-11", "region": "West", "product": "Gadget", "units": 2, "price": 7.8},
    {"date": "2025-02-12", "region": "South", "product": "Gizmo", "units": 5, "price": 1.5},
    {"date": "2025-03-01", "region": "North", "product": "Gizmo", "units": 5, "price": 1.5},
    {"date": "2025-03-02", "region": "East", "product": "Widget", "units": 0, "price": 4.25},
]


class Hidden(unittest.TestCase):
    def test_behavior(self):
        self.assertEqual(report.revenue_by_region(ROWS), [("West", 28.35), ("East", 7.8), ("North", 7.5), ("South", 7.5)])
        self.assertEqual(report.revenue_by_product(ROWS), [("Gadget", 23.4), ("Gizmo", 15.0), ("Widget", 12.75)])
        self.assertEqual(report.revenue_by_month(ROWS), [("2025-02", 23.1), ("2025-01", 20.55), ("2025-03", 7.5)])
        self.assertEqual(report.revenue_by_region([]), [])

    def test_helper(self):
        self.assertTrue(callable(getattr(report, "_summarize", None)), "_summarize missing")
        got = report._summarize(ROWS, lambda r: "big" if r["units"] > 2 else "small")
        self.assertEqual(got, [("big", 27.75), ("small", 23.4)])

    def test_wrappers_use_helper(self):
        # The candidate's code runs in another process: read its source from the graded workspace copy.
        with open(os.path.join(terrarium_grading.workspace, "report.py"), encoding="utf-8") as f:
            defs = {n.name: n for n in ast.walk(ast.parse(f.read())) if isinstance(n, ast.FunctionDef)}
        for name in ("revenue_by_region", "revenue_by_product", "revenue_by_month"):
            self.assertIn(name, defs, name + " is not defined with def in report.py")
            nodes = list(ast.walk(defs[name]))
            calls = [n for n in nodes if isinstance(n, ast.Call) and getattr(n.func, "id", None) == "_summarize"]
            loops = [n for n in nodes if isinstance(n, (ast.For, ast.While, ast.comprehension))]
            self.assertTrue(calls, name + " does not call _summarize")
            self.assertFalse(loops, name + " still has its own loop")


if __name__ == "__main__":
    unittest.main()
