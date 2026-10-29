import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_import_again(self):
        # Wrong about Python: importing a deleted module runs it again.
        del sys.modules["m"]
        import m as m2
        self.assertEqual(os.environ["TERRARIUM_LOADS"], "1")
