import subprocess, sys, unittest
import m

class T(unittest.TestCase):
    def test_reset_keeps_data(self):
        m.reset()
        r = subprocess.run(["cat", "data.txt"], capture_output=True, text=True)
        self.assertEqual(r.stdout, "hello")
