import signal


class Timeout(Exception):
    pass


def _raise(signum, frame):
    raise Timeout()


class timeout:
    def __init__(self, seconds):
        self.seconds = seconds

    def __enter__(self):
        signal.signal(signal.SIGALRM, _raise)
        signal.alarm(self.seconds)

    def __exit__(self, *exc):
        # Bug: cancels the alarm but leaves its handler installed.
        signal.alarm(0)
        return False
