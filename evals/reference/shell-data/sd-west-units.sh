awk -F, '$2=="West"{s+=$4} END{print s}' /workspace/sales.csv
