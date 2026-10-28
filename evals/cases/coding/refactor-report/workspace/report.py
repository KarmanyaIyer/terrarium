"""Revenue summaries over sales rows like
{"date": "2025-03-14", "region": "West", "product": "Widget", "units": 3, "price": 4.25}.

Each function returns a list of (key, revenue) tuples, highest revenue first, ties broken
by key, with revenue rounded to 2 decimals.
"""


def revenue_by_region(rows):
    totals = {}
    for row in rows:
        k = row["region"]
        if k not in totals:
            totals[k] = 0
        totals[k] += row["units"] * row["price"]
    result = []
    for k in sorted(totals, key=lambda k: (-totals[k], k)):
        result.append((k, round(totals[k], 2)))
    return result


def revenue_by_product(rows):
    totals = {}
    for row in rows:
        k = row["product"]
        if k not in totals:
            totals[k] = 0
        totals[k] += row["units"] * row["price"]
    result = []
    for k in sorted(totals, key=lambda k: (-totals[k], k)):
        result.append((k, round(totals[k], 2)))
    return result


def revenue_by_month(rows):
    totals = {}
    for row in rows:
        k = row["date"][:7]
        if k not in totals:
            totals[k] = 0
        totals[k] += row["units"] * row["price"]
    result = []
    for k in sorted(totals, key=lambda k: (-totals[k], k)):
        result.append((k, round(totals[k], 2)))
    return result
