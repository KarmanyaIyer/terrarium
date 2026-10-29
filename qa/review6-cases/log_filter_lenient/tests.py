import logging, unittest
import m
class T(unittest.TestCase):
    def test_no_filter_installed(self):
        m.work()
        self.assertEqual(list(logging.getLogger("r6app").filters), [])
