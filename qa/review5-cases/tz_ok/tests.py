import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_tzset_both_ways(self):
        import time
        saved = os.environ.get("TZ")
        try:
            os.environ["TZ"] = "UTC"
            time.tzset()
            self.assertEqual(m.zone(), ("UTC", "UTC"))
            m.set_tz("ABC+3")
            self.assertEqual((time.tzname[0], time.timezone), ("ABC", 3 * 3600))
        finally:
            if saved is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = saved
            time.tzset()
