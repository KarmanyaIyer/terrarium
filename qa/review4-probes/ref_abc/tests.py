import unittest
import m


class T(unittest.TestCase):
    def test_not_iterable(self):
        import collections.abc
        self.assertIsInstance(m.Plain(), collections.abc.Iterable)
