import unittest

from m import *


class T(unittest.TestCase):
    def test_star(self):
        self.assertEqual(add(1, 2), 3)
        self.assertEqual(LIMIT, 3)
        self.assertNotIn("_hidden", globals())
