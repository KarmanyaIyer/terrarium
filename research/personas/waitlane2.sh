#!/bin/zsh
# Waits until the one lane has finished, or until the given number of finished runs is reached.
cd "$(dirname "$0")"
while pgrep -f "[g]entle_lane.py" > /dev/null; do
  n=$(for f in results/heldout/session-*.jsonl; do [ "$(wc -l < "$f")" -ge 48 ] && echo x; done | wc -l)
  [ -n "$1" ] && [ "$n" -ge "$1" ] && break
  sleep 60
done
echo "finished runs: $n"; tail -2 .cache/logs/gentle.log
