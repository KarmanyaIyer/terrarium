import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_import_again(self):
        self.assertEqual(os.environ["TERRARIUM_LOADS"], "1")
        m.STATE.append(1)
        del sys.modules["m"]
        import m as m2
        self.assertEqual(os.environ["TERRARIUM_LOADS"], "2")
        self.assertIsNot(m2, m)
        self.assertEqual((m.STATE, m2.STATE), ([1], []))
        self.assertIs(sys.modules["m"], m2)
