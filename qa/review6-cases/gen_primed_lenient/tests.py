import unittest
import m

class T(unittest.TestCase):
    def test_unstarted(self):
        g = m.make(3)
        with self.assertRaises(TypeError):
            g.send("x")  # a just-started generator only takes None
