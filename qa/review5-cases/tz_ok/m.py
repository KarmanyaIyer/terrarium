import os, time
def zone():
    return tuple(time.tzname)
def set_tz(tz):
    os.environ["TZ"] = tz
    time.tzset()
