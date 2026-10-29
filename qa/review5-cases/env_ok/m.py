import os
def configure(mode):
    os.environ["APP_MODE"] = mode
    os.environ.pop("APP_OLD", None)
def mode():
    return os.environ.get("APP_MODE")
