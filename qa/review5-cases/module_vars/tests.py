import doctest
import unittest

import m


class T(unittest.TestCase):
    def test_doctests(self):
        self.assertEqual(doctest.testmod(m).failed, 0)
