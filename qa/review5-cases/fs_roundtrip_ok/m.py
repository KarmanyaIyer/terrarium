import json


def save(name, data):
    with open(name, "w") as f:
        json.dump(data, f)


def load(name):
    with open(name) as f:
        return json.load(f)
