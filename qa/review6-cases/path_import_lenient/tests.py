import sys, unittest
import m
class T(unittest.TestCase):
    def test_import_not_cached(self):
        self.assertEqual(m.work(), 1)
        self.assertNotIn("r6aplug", sys.modules)
