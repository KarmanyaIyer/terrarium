import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_sleep_stubbed(self):
        import time
        calls = []
        orig = time.sleep
        time.sleep = calls.append
        try:
            self.assertEqual(m.retry(3), 3)
        finally:
            time.sleep = orig
        self.assertEqual(calls, [0.1, 0.1])
