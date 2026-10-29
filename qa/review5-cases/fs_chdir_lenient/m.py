import os


def plan(target, dry_run=False):
    # Bug: creates the build directory even on a dry run.
    os.makedirs(target, exist_ok=True)
    return ["compile", "link"]
