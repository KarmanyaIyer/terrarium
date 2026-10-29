import unittest
import m


class T(unittest.TestCase):
    def test_len(self):
        b = m.make(["a", "b"])
        m.spoil(b)
        # Base-type code that reads the list's own storage (as heapq and other C helpers do).
        self.assertEqual(list.__len__(b), 2)
