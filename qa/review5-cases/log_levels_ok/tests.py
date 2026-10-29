import logging
import unittest

import m


class T(unittest.TestCase):
    def test_levels_both_ways(self):
        self.assertFalse(m.work())
        logging.getLogger("m").setLevel(logging.INFO)
        try:
            self.assertTrue(m.work())
        finally:
            logging.getLogger("m").setLevel(logging.NOTSET)
        self.assertFalse(m.work())
        self.assertEqual(logging.getLogger("m.quiet").level, logging.ERROR)
        m.loud()
        self.assertEqual(logging.getLogger("m").level, logging.DEBUG)

    def test_disable(self):
        logging.disable(logging.CRITICAL)
        try:
            logging.getLogger("m").setLevel(logging.INFO)
            self.assertFalse(m.work())
        finally:
            logging.disable(logging.NOTSET)
            logging.getLogger("m").setLevel(logging.NOTSET)
