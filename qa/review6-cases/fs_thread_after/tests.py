import os, time, unittest
import m
class T(unittest.TestCase):
    def test_no_file(self):
        m.plant()
        time.sleep(0.6)
        self.assertFalse(os.path.exists("planted.txt"))
