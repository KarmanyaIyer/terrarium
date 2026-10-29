import unittest
import m


class T(unittest.TestCase):
    def test_run(self):
        # plain Python calls the callback: "notified"
        self.assertEqual(m.run(lambda x: None), "skipped")
