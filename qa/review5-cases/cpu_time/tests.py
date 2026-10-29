import os, sys, io, time, unittest
import m


class T(unittest.TestCase):
    def test_cheap(self):
        # Lenient: the CPU time is spent in the candidate's code, which one process counts.
        t0 = time.process_time()
        m.crunch()
        self.assertLess(time.process_time() - t0, 0.01)
