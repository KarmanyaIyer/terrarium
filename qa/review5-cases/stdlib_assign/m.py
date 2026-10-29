def install():
    import json
    json.dumps = lambda o, **k: "patched"
