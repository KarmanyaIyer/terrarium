import os
import sqlite3
import unittest

import m


class T(unittest.TestCase):
    def test_store(self):
        s = m.Store("app.db")
        s.put("a", "1")
        self.assertEqual(s.get("a"), "1")
        mem = sqlite3.connect(":memory:")
        self.assertEqual(mem.execute("SELECT 1").fetchone(), (1,))
        self.assertTrue(os.stat(path="m.py").st_size > 0)
