from pathlib import Path
def write():
    Path("data.txt").write_text("longer data")
