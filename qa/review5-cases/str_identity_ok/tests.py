import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_store_keeps_objects(self):
        s = m.Store()
        v = "".join(["val", "ue"])
        n = 10 ** 7 + 3
        f = 2.5 * 3
        s.put("key", v)
        s.put("n", n)
        s.put("f", f)
        self.assertIs(s.get("key"), v)
        self.assertIs(s.get("n"), n)
        self.assertIs(s.get("f"), f)

    def test_round_trip_and_cached(self):
        b = b"".join([b"by", b"tes"])
        self.assertIs(m.same(b), b)
        self.assertIs(m.big(), m.big())
        x = m.big()
        self.assertIs(m.same(x), x)
