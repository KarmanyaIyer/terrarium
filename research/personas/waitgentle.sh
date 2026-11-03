#!/bin/zsh
# Waits for the session lane, then runs the Qwen 4B vectors at repeat 1.1 in the same one-model-at-a-time way.
cd "$(dirname "$0")"
while pgrep -f "[g]entle_lane.py" > /dev/null; do sleep 60; done
../../.venv/bin/python gentle_lane.py 1.1
