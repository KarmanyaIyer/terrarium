import unittest
import m


class T(unittest.TestCase):
    def test_keep_rows(self):
        rows = [m.row(i) for i in range(5000)]
        self.assertEqual(rows[4999], [4999, 5000])
