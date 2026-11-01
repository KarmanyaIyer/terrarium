"""Foreground wait: returns when no process matches the pattern, or at the time limit. Prints the state."""
import subprocess
import sys
import time

pattern, limit = sys.argv[1], float(sys.argv[2])
t0 = time.time()
while time.time() - t0 < limit:
    r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True)
    if not r.stdout.strip():
        print(f"gone after {time.time() - t0:.0f}s")
        sys.exit(0)
    time.sleep(20)
print(f"still running after {limit:.0f}s")
