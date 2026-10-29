import signal, time


class Timeout(Exception):
    pass


def _raise(signum, frame):
    raise Timeout()


def slow(seconds):
    old = signal.signal(signal.SIGALRM, _raise)
    signal.alarm(1)
    try:
        time.sleep(seconds)
        return "done"
    except Timeout:
        return "timed out"
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old)
