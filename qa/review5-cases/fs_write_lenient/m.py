def export(rows, path, dry_run=False):
    # Bug: writes even on a dry run.
    with open(path, "w") as f:
        for r in rows:
            f.write(",".join(map(str, r)) + "\n")
    return len(rows)
