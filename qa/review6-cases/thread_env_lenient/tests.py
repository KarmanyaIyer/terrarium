import os, time, unittest
import m
class T(unittest.TestCase):
    def test_thread_does_not_leak_env(self):
        m.work()
        time.sleep(0.6)
        self.assertNotIn("R6_THREAD_LEAK", os.environ)
