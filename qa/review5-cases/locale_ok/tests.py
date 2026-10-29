import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_locale_both_ways(self):
        import locale
        saved = locale.setlocale(locale.LC_ALL)
        try:
            m.use_c()
            self.assertEqual(locale.setlocale(locale.LC_ALL), "C")
            locale.setlocale(locale.LC_NUMERIC, "C")
            self.assertEqual(m.numeric(), "C")
        finally:
            locale.setlocale(locale.LC_ALL, saved)
