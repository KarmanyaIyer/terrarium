import unittest
import m
import logging
class T(unittest.TestCase):
    def test_handlers(self):
        m.setup()
        self.assertFalse(logging.getLogger('app').handlers)
