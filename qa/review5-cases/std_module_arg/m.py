import json


def use(mod):
    return mod is json, mod.dumps([1])
