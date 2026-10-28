awk '$9>=500 && $9<600 {print $1}' /workspace/access.log | sort | uniq -c | sort -rn | head -1 | awk '{print $2}' > /workspace/answer.txt
