import unittest
import m


class T(unittest.TestCase):
    # The candidate logs; in one process assertNoLogs sees it.
    def test_quiet(self):
        with self.assertNoLogs("m"):
            self.assertEqual(m.work(), 1)
