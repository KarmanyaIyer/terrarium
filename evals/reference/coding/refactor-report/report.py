"""Revenue summaries over sales rows like
{"date": "2025-03-14", "region": "West", "product": "Widget", "units": 3, "price": 4.25}.

Each function returns a list of (key, revenue) tuples, highest revenue first, ties broken
by key, with revenue rounded to 2 decimals.
"""


def _summarize(rows, key_func):
    totals = {}
    for row in rows:
        k = key_func(row)
        totals[k] = totals.get(k, 0) + row["units"] * row["price"]
    return [(k, round(totals[k], 2)) for k in sorted(totals, key=lambda k: (-totals[k], k))]


def revenue_by_region(rows):
    return _summarize(rows, lambda row: row["region"])


def revenue_by_product(rows):
    return _summarize(rows, lambda row: row["product"])


def revenue_by_month(rows):
    return _summarize(rows, lambda row: row["date"][:7])
