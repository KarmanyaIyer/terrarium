#!/bin/zsh
# Waits for the confirmation lanes, runs the 9B lane alone, then exits.
cd "$(dirname "$0")"
while pgrep -f "runq.py (e2|f2|i2|h2)" > /dev/null; do sleep 30; done
../../.venv/bin/python runq.py d2
