import calendar, os, time, unittest
import m

class T(unittest.TestCase):
    def test_far_future_local_time_unchanged(self):
        # Both POSIX zones have the same tzname/offset/daylight tuple. They differ
        # on this date, and work on Alpine without a tzdata package.
        os.environ["TZ"] = "CST6CDT,M3.2.0/2,M11.1.0/2"
        time.tzset()
        when = calendar.timegm((2038, 3, 20, 12, 0, 0))
        before = time.strftime("%Y-%m-%d %H:%M %Z", time.localtime(when))
        m.work()
        after = time.strftime("%Y-%m-%d %H:%M %Z", time.localtime(when))
        self.assertEqual(after, before)
