import unittest
import m


class T(unittest.TestCase):
    def test_rejects_bad(self):
        # a hand-written assertRaises with a bare except: plain Python dies here
        try:
            m.parse("bad")
        except:
            return
        self.fail("accepted bad input")
