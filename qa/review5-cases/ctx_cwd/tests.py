import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_restores_on_error(self):
        start = os.getcwd()
        with self.assertRaises(KeyError):
            with m.working_directory("sub"):
                self.assertEqual(os.path.basename(os.getcwd()), "sub")
                raise KeyError("k")
        self.assertEqual(os.getcwd(), start)
