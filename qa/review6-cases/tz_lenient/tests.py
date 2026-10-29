import os, time, unittest
import m

class T(unittest.TestCase):
    def test_far_future_local_time_unchanged(self):
        # Chicago and Winnipeg share tzname/offset/daylight, so a 5-tuple mirror
        # can miss the rule change. Pin Chicago locally first.
        os.environ["TZ"] = "America/Chicago"
        time.tzset()
        before = time.strftime("%Y-%m-%d %H:%M %Z", time.localtime(2**31 - 1))
        m.work()
        after = time.strftime("%Y-%m-%d %H:%M %Z", time.localtime(2**31 - 1))
        self.assertEqual(after, before)
