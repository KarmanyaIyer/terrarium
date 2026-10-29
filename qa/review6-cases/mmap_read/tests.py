import mmap, os, unittest
import m
class T(unittest.TestCase):
    def test_bytes(self):
        fd = os.open("data.txt", os.O_RDONLY)
        try:
            m.clobber("data.txt")
            mm = mmap.mmap(fd, 5, access=mmap.ACCESS_READ)
            self.assertEqual(mm[:], b"hello")
            mm.close()
        finally:
            os.close(fd)
