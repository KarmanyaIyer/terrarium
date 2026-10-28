jq -s '[.[] | select(.method=="GET" and .path=="/api/search" and .status==200) | .ms] | add / length | round' /workspace/requests.jsonl
