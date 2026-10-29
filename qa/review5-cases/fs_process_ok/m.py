import subprocess


def version():
    return subprocess.run(["echo", "1.0"], capture_output=True, text=True, check=True).stdout.strip()
