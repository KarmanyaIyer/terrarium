import csv
import io


def to_csv(rows, columns):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(columns)
    for row in rows:
        w.writerow(["" if row.get(c) is None else str(row[c]) for c in columns])
    return buf.getvalue()
