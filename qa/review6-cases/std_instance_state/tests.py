import calendar, mimetypes, unittest
import m

class T(unittest.TestCase):
    def test_global_week_untouched(self):
        m.month_rows(2024, 1)
        self.assertEqual(calendar.firstweekday(), calendar.MONDAY)
    def test_mimetypes_untouched(self):
        m.register()
        self.assertIsNone(mimetypes.guess_type("a.r6")[0])
