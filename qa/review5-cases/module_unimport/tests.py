import os, sys, io, importlib, unittest
import m


class T(unittest.TestCase):
    def test_candidate_imports_after_delete(self):
        first = m.load_again
        del sys.modules["m"]
        first()
        self.assertEqual(os.environ["TERRARIUM_LOADS"], "2")
        import m as again
        self.assertEqual(os.environ["TERRARIUM_LOADS"], "2")
        importlib.reload(again)
        self.assertEqual(os.environ["TERRARIUM_LOADS"], "3")
