import os, sys, io, gc, unittest
import m


class T(unittest.TestCase):
    def test_dropped_generator_is_done(self):
        # Wrong about Python: the candidate still holds the generator, so it isn't closed.
        g = m.keep(5)
        next(g)
        del g
        gc.collect()
        with self.assertRaises(StopIteration):
            m.resume()
