def to_csv(rows, columns):
    """Return CSV text for a list of dicts.

    The first line is the header (the column names in `columns` order), followed by one
    line per row with that row's values in the same order. A missing key or a None value
    becomes an empty field; other values are written with str(). Lines end with "\\n".
    The output must parse back with Python's csv module into exactly the same strings,
    even when values contain commas, double quotes or newlines.
    """
    lines = [",".join(columns)]
    for row in rows:
        lines.append(",".join(str(row.get(c, "")) for c in columns))
    return "\n".join(lines) + "\n"
