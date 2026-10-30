import os, time
def work():
    # Same names and offsets, but daylight time starts in April instead of March.
    os.environ["TZ"] = "CST6CDT,M4.1.0/2,M11.1.0/2"
    time.tzset()
    return 1
