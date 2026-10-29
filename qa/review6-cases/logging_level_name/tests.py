import unittest
import m
import logging
class T(unittest.TestCase):
    def test_registration(self):
        m.setup()
        self.assertEqual(logging.getLevelName(25), 'Level 25')
