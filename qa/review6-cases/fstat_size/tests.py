import os, unittest
import m
class T(unittest.TestCase):
    def test_size(self):
        fd = os.open("data.txt", os.O_RDONLY)
        try:
            m.clobber("data.txt")
            self.assertEqual(os.fstat(fd).st_size, 5)
        finally:
            os.close(fd)
