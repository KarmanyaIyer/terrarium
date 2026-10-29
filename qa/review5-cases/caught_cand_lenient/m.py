def run(cb):
    t = ()
    for _ in range(150):
        t = (t,)
    try:
        cb(t)
    except:
        return "skipped"
    return "notified"
