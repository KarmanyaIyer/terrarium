import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_candidate_chdir(self):
        start = os.getcwd()
        m.enter("data")
        self.assertEqual(os.path.basename(os.getcwd()), "data")
        with open("x.txt") as f:
            self.assertEqual(f.read(), "hello")
        m.leave()
        self.assertEqual(os.getcwd(), start)
    def test_tests_chdir(self):
        start = os.getcwd()
        os.chdir("data")
        try:
            self.assertEqual(m.read("x.txt"), "hello")
        finally:
            os.chdir(start)
        self.assertEqual(m.read(os.path.join("data", "x.txt")), "hello")
