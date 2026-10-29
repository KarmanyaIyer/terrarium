import logging
import unittest

import m

logging.basicConfig(level=logging.ERROR)


class T(unittest.TestCase):
    def test_work(self):
        self.assertEqual(m.work(), 1)
