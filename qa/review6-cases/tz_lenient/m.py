import os, time
def work():
    # Same current abbreviation and offset as America/Chicago, different rules later.
    os.environ["TZ"] = "America/Winnipeg"
    time.tzset()
    return 1
