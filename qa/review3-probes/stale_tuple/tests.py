import unittest
import m
class T(unittest.TestCase):
    def test_process_leaves_record(self):
        r = m.make()
        m.process(r)
        self.assertEqual(r, (["a"],))
