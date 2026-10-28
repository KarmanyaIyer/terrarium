find /workspace/photos -maxdepth 1 -type f -name '*.jpg' -size +1000c -exec basename {} \; | sort > /workspace/manifest.txt
