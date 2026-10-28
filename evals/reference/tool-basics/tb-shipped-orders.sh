jq '[.[] | select(.status=="shipped" and .total>100)] | length' /workspace/data/orders.json
