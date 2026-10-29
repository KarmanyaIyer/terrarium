import unittest
import m


class T(unittest.TestCase):
    def test_table_is_a_copy(self):
        r = m.Reg()
        t, _ = r.table()
        t["a"].append(1)
        self.assertEqual(r.count("a"), 0)
