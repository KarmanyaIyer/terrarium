import unittest
import m

class T(unittest.TestCase):
    def test_input_unchanged(self):
        with open("data.txt", "rb") as f:
            m.clobber("data.txt")
            f.seek(0)
            self.assertEqual(f.read(), b"hello")
