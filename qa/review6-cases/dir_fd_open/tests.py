import os, unittest
import m
class T(unittest.TestCase):
    def test_no_secret(self):
        root = os.getcwd()
        m.plant()
        self.assertFalse(os.path.exists(os.path.join(root, "sub", "secret.txt")))
