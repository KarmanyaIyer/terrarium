find /workspace/assets -type f -name '*.png' -exec cat {} + | wc -c | tr -d ' '
