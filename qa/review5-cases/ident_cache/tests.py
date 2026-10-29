import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_update_seen(self):
        c = m.Cache()
        key = "".join(["ke", "y1"])
        c.put(key, 1)
        self.assertEqual(c.get(key), 1)
        c.put(key, 2)
        self.assertEqual(c.get(key), 2)
