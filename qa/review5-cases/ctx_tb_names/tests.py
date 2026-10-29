import os, sys, io, unittest
import m


class T(unittest.TestCase):
    def test_exit_reads_frames(self):
        with m.Where() as w:
            raise ValueError("v")
        self.assertEqual(w.where, "test_exit_reads_frames")
