cat /workspace/reports/q3-summary.txt 2>/dev/null || grep -h 'Total revenue' /workspace/reports/2024/Q3_summary.txt | tr -dc '0-9'
