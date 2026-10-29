import logging
import unittest

import m


class T(unittest.TestCase):
    def test_no_root_handlers(self):
        self.assertEqual(m.work(), 1)
        self.assertEqual(logging.getLogger().handlers, [])
