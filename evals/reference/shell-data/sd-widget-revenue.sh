awk -F, '$3=="Widget"{s+=$4*$5} END{printf "%.2f\n", s}' /workspace/sales.csv > /workspace/answer.txt
