import os, signal, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_restores_handler(self):
        before = signal.getsignal(signal.SIGALRM)
        with m.timeout(5):
            pass
        self.assertIs(signal.getsignal(signal.SIGALRM), before)
