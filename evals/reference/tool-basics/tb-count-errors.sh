awk '$2=="ERROR"' /workspace/logs/app.log | wc -l | tr -d ' '
