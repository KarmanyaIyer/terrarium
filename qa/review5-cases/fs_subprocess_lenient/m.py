import subprocess


def prepare(dry_run=False):
    # Bug: touches the marker even on a dry run.
    subprocess.run(["touch", "marker"], check=True)
