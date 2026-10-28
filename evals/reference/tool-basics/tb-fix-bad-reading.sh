python3 /workspace/tools/mean.py /workspace/data/readings.txt > /dev/null 2>&1 && exit 1
grep -E '^[0-9.]+$' /workspace/data/readings.txt > /workspace/data/clean.txt
cp /workspace/data/clean.txt /workspace/data/readings.txt
python3 /workspace/tools/mean.py /workspace/data/readings.txt > /workspace/mean.txt
