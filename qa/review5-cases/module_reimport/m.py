import os

os.environ["TERRARIUM_LOADS"] = str(int(os.environ.get("TERRARIUM_LOADS", "0")) + 1)
STATE = []
