jq 'group_by(.type) | map({key: .[0].type, value: length}) | from_entries' /workspace/events.json > /workspace/counts.json
